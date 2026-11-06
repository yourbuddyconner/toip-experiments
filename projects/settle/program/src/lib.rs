//! Settle escrow (design: projects/settle/docs/design.md §5).
//!
//! One escrow per payment holds a price plus the processor's facilitator fee, in an SPL token.
//! It pays out only when at least `threshold` of three named Ed25519 keys (payer, payee, arbiter)
//! have signed the exact outcome, as a message verified by the Ed25519 precompile earlier in the
//! same transaction. Nobody, including whoever submits the transaction, can move the funds alone.
//! The fee is fixed at opening and paid on every outcome (release, split, refund or reclaim);
//! conditions live in each signer's policy, not here.
//!
//! Instructions:
//!   0 open     payer funds a new escrow for `terms_hash` with the price plus the fee
//!   1 resolve  pay the fee to the processor, `payee_amount` of the price to the payee and the rest back to the payer,
//!              given a quorum of signatures over `settle/v1|<program>|<escrow>|pay:<n>|evidence:<hex>`
//!   2 reclaim  after `refund_after`, the payer alone takes the price back (the fee is still paid)
//!
//! An escrow account is never closed, only marked resolved, so its address can't be reused and old
//! signatures can't be replayed against a new escrow for the same terms.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::{instructions as ix_sysvar, Sysvar},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const SYSTEM_PROGRAM_ID: Pubkey = pubkey!("11111111111111111111111111111111");

pub const ESCROW_LEN: usize = 296;
const TOKEN_ACCOUNT_LEN: usize = 165;

pub const STATE_FUNDED: u8 = 1;
pub const STATE_RESOLVED: u8 = 2;
pub const STATE_RECLAIMED: u8 = 3;

/// Custom errors, so clients can tell failures apart.
#[repr(u32)]
pub enum SettleError {
    BadInstruction = 1,
    BadAccount = 2,
    NotFunded = 3,
    NoQuorum = 4,
    TooEarly = 5,
    BadAmount = 6,
    WrongTokenAccount = 7,
}
impl From<SettleError> for ProgramError {
    fn from(e: SettleError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

/// The escrow account's fixed layout.
pub struct Escrow {
    pub state: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub threshold: u8,
    pub fee_bps: u16,
    pub terms_hash: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub arbiter: Pubkey,
    pub fee_account: Pubkey,
    pub rent_payer: Pubkey,
    pub refund_after: i64,
    pub payee_paid: u64,
    pub evidence_hash: [u8; 32],
    /// The facilitator fee, in token units, held on top of `amount` and paid on every outcome.
    pub fee: u64,
}

impl Escrow {
    fn read(d: &[u8]) -> Result<Self, ProgramError> {
        if d.len() < ESCROW_LEN {
            return Err(SettleError::BadAccount.into());
        }
        let pk = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
        let arr = |o: usize| -> [u8; 32] { d[o..o + 32].try_into().unwrap() };
        Ok(Escrow {
            state: d[0],
            bump: d[1],
            vault_bump: d[2],
            threshold: d[3],
            fee_bps: u16::from_le_bytes([d[4], d[5]]),
            terms_hash: arr(6),
            mint: pk(38),
            amount: u64::from_le_bytes(d[70..78].try_into().unwrap()),
            payer: pk(78),
            payee: pk(110),
            arbiter: pk(142),
            fee_account: pk(174),
            rent_payer: pk(206),
            refund_after: i64::from_le_bytes(d[238..246].try_into().unwrap()),
            payee_paid: u64::from_le_bytes(d[246..254].try_into().unwrap()),
            evidence_hash: arr(254),
            fee: u64::from_le_bytes(d[286..294].try_into().unwrap()),
        })
    }

    fn write(&self, d: &mut [u8]) {
        d[0] = self.state;
        d[1] = self.bump;
        d[2] = self.vault_bump;
        d[3] = self.threshold;
        d[4..6].copy_from_slice(&self.fee_bps.to_le_bytes());
        d[6..38].copy_from_slice(&self.terms_hash);
        d[38..70].copy_from_slice(self.mint.as_ref());
        d[70..78].copy_from_slice(&self.amount.to_le_bytes());
        d[78..110].copy_from_slice(self.payer.as_ref());
        d[110..142].copy_from_slice(self.payee.as_ref());
        d[142..174].copy_from_slice(self.arbiter.as_ref());
        d[174..206].copy_from_slice(self.fee_account.as_ref());
        d[206..238].copy_from_slice(self.rent_payer.as_ref());
        d[238..246].copy_from_slice(&self.refund_after.to_le_bytes());
        d[246..254].copy_from_slice(&self.payee_paid.to_le_bytes());
        d[254..286].copy_from_slice(&self.evidence_hash);
        d[286..294].copy_from_slice(&self.fee.to_le_bytes());
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => open(program_id, accounts, &data[1..]),
        Some(1) => resolve(program_id, accounts, &data[1..]),
        Some(2) => reclaim(program_id, accounts),
        _ => Err(SettleError::BadInstruction.into()),
    }
}

// ---------------------------------------------------------------- helpers

struct Reader<'a> {
    d: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], ProgramError> {
        let s = self.d.get(self.at..self.at + n).ok_or(ProgramError::from(SettleError::BadInstruction))?;
        self.at += n;
        Ok(s)
    }
    fn arr32(&mut self) -> Result<[u8; 32], ProgramError> {
        Ok(self.take(32)?.try_into().unwrap())
    }
    fn u64(&mut self) -> Result<u64, ProgramError> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64, ProgramError> {
        Ok(i64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn u16(&mut self) -> Result<u16, ProgramError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u8(&mut self) -> Result<u8, ProgramError> {
        Ok(self.take(1)?[0])
    }
}

/// Checks an SPL token account: owned by the token program, of `mint`, held by `owner`.
fn check_token_account(acc: &AccountInfo, mint: &Pubkey, owner: Option<&Pubkey>) -> ProgramResult {
    if acc.owner != &TOKEN_PROGRAM_ID {
        msg!("not a token account: {}", acc.key);
        return Err(SettleError::WrongTokenAccount.into());
    }
    let d = acc.try_borrow_data()?;
    if d.len() < TOKEN_ACCOUNT_LEN || &d[0..32] != mint.as_ref() {
        msg!("token account {} has the wrong mint", acc.key);
        return Err(SettleError::WrongTokenAccount.into());
    }
    if let Some(o) = owner {
        if &d[32..64] != o.as_ref() {
            msg!("token account {} isn't held by {}", acc.key, o);
            return Err(SettleError::WrongTokenAccount.into());
        }
    }
    Ok(())
}

fn token_transfer<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    let mut data = vec![3u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from.key, false), AccountMeta::new(*to.key, false), AccountMeta::new_readonly(*authority.key, true)],
        data,
    };
    let infos = [from.clone(), to.clone(), authority.clone(), token_program.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s]),
        None => invoke(&ix, &infos),
    }
}

fn token_close<'a>(token_program: &AccountInfo<'a>, account: &AccountInfo<'a>, dest: &AccountInfo<'a>, owner: &AccountInfo<'a>, seeds: &[&[u8]]) -> ProgramResult {
    let ix = Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new(*dest.key, false), AccountMeta::new_readonly(*owner.key, true)],
        data: vec![9u8],
    };
    invoke_signed(&ix, &[account.clone(), dest.clone(), owner.clone(), token_program.clone()], &[seeds])
}

/// Creates a program-derived account, even if someone already sent lamports to its address to block
/// `create_account` (a cheap way to grief any escrow, since escrow addresses are predictable).
fn create_pda_account<'a>(
    rent_payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> ProgramResult {
    use solana_system_interface::instruction as sys;
    let needed = Rent::get()?.minimum_balance(space);
    if target.lamports() == 0 {
        return invoke_signed(
            &sys::create_account(rent_payer.key, target.key, needed, space as u64, owner),
            &[rent_payer.clone(), target.clone(), system_program.clone()],
            &[seeds],
        );
    }
    if target.owner != &SYSTEM_PROGRAM_ID || !target.data_is_empty() {
        msg!("address {} is already in use", target.key);
        return Err(SettleError::BadAccount.into());
    }
    let short = needed.saturating_sub(target.lamports());
    if short > 0 {
        invoke(&sys::transfer(rent_payer.key, target.key, short), &[rent_payer.clone(), target.clone(), system_program.clone()])?;
    }
    invoke_signed(&sys::allocate(target.key, space as u64), &[target.clone(), system_program.clone()], &[seeds])?;
    invoke_signed(&sys::assign(target.key, owner), &[target.clone(), system_program.clone()], &[seeds])
}

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 15) as usize] as char);
    }
    s
}

/// The exact message signers sign to approve an outcome (design §5).
pub fn outcome_message(program_id: &Pubkey, escrow: &Pubkey, payee_amount: u64, evidence_hash: &[u8; 32]) -> Vec<u8> {
    format!("settle/v1|{}|{}|pay:{}|evidence:{}", program_id, escrow, payee_amount, hex(evidence_hash)).into_bytes()
}

/// Which of `keys` signed `expected`, according to Ed25519 precompile instructions earlier in this transaction.
/// Only signatures whose key, signature and message all sit inside the precompile instruction's own data count.
fn signers_in_transaction(ix_sysvar_acc: &AccountInfo, expected: &[u8], keys: &[Pubkey; 3]) -> Result<[bool; 3], ProgramError> {
    if ix_sysvar_acc.key != &ix_sysvar::ID {
        return Err(SettleError::BadAccount.into());
    }
    let current = ix_sysvar::load_current_index_checked(ix_sysvar_acc)? as usize;
    let mut signed = [false; 3];
    for i in 0..current {
        let ix = ix_sysvar::load_instruction_at_checked(i, ix_sysvar_acc)?;
        if ix.program_id != ED25519_PROGRAM_ID || ix.data.len() < 2 {
            continue;
        }
        let d = &ix.data;
        let count = d[0] as usize;
        for n in 0..count {
            let o = 2 + n * 14;
            let Some(off) = d.get(o..o + 14) else { break };
            let r = |k: usize| u16::from_le_bytes([off[k], off[k + 1]]);
            let (sig_ix, pk_off, pk_ix, msg_off, msg_len, msg_ix) = (r(2), r(4) as usize, r(6), r(8) as usize, r(10) as usize, r(12));
            if sig_ix != u16::MAX || pk_ix != u16::MAX || msg_ix != u16::MAX {
                continue;
            }
            let (Some(pk), Some(m)) = (d.get(pk_off..pk_off + 32), d.get(msg_off..msg_off + msg_len)) else { continue };
            if m != expected {
                continue;
            }
            for (k, key) in keys.iter().enumerate() {
                if pk == key.as_ref() {
                    signed[k] = true;
                }
            }
        }
    }
    Ok(signed)
}

// ---------------------------------------------------------------- open

fn open(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let rent_payer = next_account_info(it)?;
    let escrow = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let payer_token = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let fee_account = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system_program = next_account_info(it)?;

    let mut r = Reader { d: data, at: 0 };
    let terms_hash = r.arr32()?;
    let amount = r.u64()?;
    let payee = Pubkey::new_from_array(r.arr32()?);
    let arbiter = Pubkey::new_from_array(r.arr32()?);
    let threshold = r.u8()?;
    let fee_bps = r.u16()?;
    let fee = r.u64()?;
    let refund_after = r.i64()?;

    if !payer.is_signer || !rent_payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token_program.key != &TOKEN_PROGRAM_ID || system_program.key != &SYSTEM_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    if amount == 0 || !(1..=3).contains(&threshold) || fee_bps > 10_000 {
        return Err(SettleError::BadInstruction.into());
    }
    let (escrow_key, bump) = Pubkey::find_program_address(&[b"escrow", &terms_hash], program_id);
    let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", escrow_key.as_ref()], program_id);
    if escrow.key != &escrow_key || vault.key != &vault_key {
        msg!("escrow or vault address doesn't match the terms");
        return Err(SettleError::BadAccount.into());
    }
    check_token_account(payer_token, mint.key, Some(payer.key))?;
    check_token_account(fee_account, mint.key, None)?;

    let escrow_seeds: &[&[u8]] = &[b"escrow", &terms_hash, &[bump]];
    let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];

    // The escrow account. It can't be created twice, so each terms hash is funded once.
    create_pda_account(rent_payer, escrow, system_program, ESCROW_LEN, program_id, escrow_seeds)?;
    // The vault: a token account the escrow PDA owns.
    create_pda_account(rent_payer, vault, system_program, TOKEN_ACCOUNT_LEN, &TOKEN_PROGRAM_ID, vault_seeds)?;
    let mut init = vec![18u8]; // InitializeAccount3 { owner }
    init.extend_from_slice(escrow_key.as_ref());
    invoke(
        &Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![AccountMeta::new(*vault.key, false), AccountMeta::new_readonly(*mint.key, false)],
            data: init,
        },
        &[vault.clone(), mint.clone(), token_program.clone()],
    )?;
    let total = amount.checked_add(fee).ok_or(ProgramError::from(SettleError::BadAmount))?;
    token_transfer(token_program, payer_token, vault, payer, total, None)?;

    let state = Escrow {
        state: STATE_FUNDED,
        bump,
        vault_bump,
        threshold,
        fee_bps,
        terms_hash,
        mint: *mint.key,
        amount,
        payer: *payer.key,
        payee,
        arbiter,
        fee_account: *fee_account.key,
        rent_payer: *rent_payer.key,
        refund_after,
        payee_paid: 0,
        evidence_hash: [0; 32],
        fee,
    };
    state.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: opened {} for {} plus fee {}", escrow.key, amount, fee);
    Ok(())
}

// ---------------------------------------------------------------- resolve

fn resolve(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let escrow = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let payee_token = next_account_info(it)?;
    let payer_token = next_account_info(it)?;
    let fee_token = next_account_info(it)?;
    let rent_payer = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    let mut r = Reader { d: data, at: 0 };
    let payee_amount = r.u64()?;
    let evidence_hash = r.arr32()?;

    if escrow.owner != program_id || token_program.key != &TOKEN_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    let mut s = Escrow::read(&escrow.try_borrow_data()?)?;
    if s.state != STATE_FUNDED {
        return Err(SettleError::NotFunded.into());
    }
    if payee_amount > s.amount {
        return Err(SettleError::BadAmount.into());
    }
    let vault_key = Pubkey::create_program_address(&[b"vault", escrow.key.as_ref(), &[s.vault_bump]], program_id)?;
    if vault.key != &vault_key || rent_payer.key != &s.rent_payer || fee_token.key != &s.fee_account {
        return Err(SettleError::BadAccount.into());
    }
    check_token_account(payee_token, &s.mint, Some(&s.payee))?;
    check_token_account(payer_token, &s.mint, Some(&s.payer))?;

    let expected = outcome_message(program_id, escrow.key, payee_amount, &evidence_hash);
    let signed = signers_in_transaction(ixs, &expected, &[s.payer, s.payee, s.arbiter])?;
    let count = signed.iter().filter(|x| **x).count() as u8;
    if count < s.threshold {
        msg!("settle: {} of {} needed signatures", count, s.threshold);
        return Err(SettleError::NoQuorum.into());
    }

    let refund = s.amount - payee_amount;
    let seeds: &[&[u8]] = &[b"escrow", &s.terms_hash, &[s.bump]];
    if payee_amount > 0 {
        token_transfer(token_program, vault, payee_token, escrow, payee_amount, Some(seeds))?;
    }
    if s.fee > 0 {
        token_transfer(token_program, vault, fee_token, escrow, s.fee, Some(seeds))?;
    }
    if refund > 0 {
        token_transfer(token_program, vault, payer_token, escrow, refund, Some(seeds))?;
    }
    token_close(token_program, vault, rent_payer, escrow, seeds)?;

    s.state = STATE_RESOLVED;
    s.payee_paid = payee_amount;
    s.evidence_hash = evidence_hash;
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: resolved {}: payee {}, fee {}, refund {}", escrow.key, payee_amount, s.fee, refund);
    Ok(())
}

// ---------------------------------------------------------------- reclaim

fn reclaim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let escrow = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let payer_token = next_account_info(it)?;
    let fee_token = next_account_info(it)?;
    let rent_payer = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if escrow.owner != program_id || token_program.key != &TOKEN_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    let mut s = Escrow::read(&escrow.try_borrow_data()?)?;
    if s.state != STATE_FUNDED {
        return Err(SettleError::NotFunded.into());
    }
    if fee_token.key != &s.fee_account {
        return Err(SettleError::BadAccount.into());
    }
    if !payer.is_signer || payer.key != &s.payer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if Clock::get()?.unix_timestamp <= s.refund_after {
        return Err(SettleError::TooEarly.into());
    }
    let vault_key = Pubkey::create_program_address(&[b"vault", escrow.key.as_ref(), &[s.vault_bump]], program_id)?;
    if vault.key != &vault_key || rent_payer.key != &s.rent_payer {
        return Err(SettleError::BadAccount.into());
    }
    check_token_account(payer_token, &s.mint, Some(&s.payer))?;
    let seeds: &[&[u8]] = &[b"escrow", &s.terms_hash, &[s.bump]];
    token_transfer(token_program, vault, payer_token, escrow, s.amount, Some(seeds))?;
    if s.fee > 0 {
        token_transfer(token_program, vault, fee_token, escrow, s.fee, Some(seeds))?;
    }
    token_close(token_program, vault, rent_payer, escrow, seeds)?;
    s.state = STATE_RECLAIMED;
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: reclaimed {}", escrow.key);
    Ok(())
}
