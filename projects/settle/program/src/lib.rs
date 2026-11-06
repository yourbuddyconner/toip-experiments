//! Settle escrow, version 2 (design: projects/settle/docs/design.md §5, §15–16).
//!
//! One escrow per payment holds a price plus the processor's facilitator fee, in an SPL token. It pays
//! out only when at least `threshold` of three distinct Ed25519 keys (payer, payee, arbiter) have signed
//! the exact outcome, as a message verified by the Ed25519 precompile earlier in the same transaction.
//! Nobody, including whoever submits the transaction, can move the funds alone.
//!
//! Instructions:
//!   0 open     the payer funds a new escrow with the price plus the fee
//!   1 resolve  given a quorum over `settle/v2|<program>|<escrow>|pay:<n>|evidence:<hex>`: the fee to the
//!              processor, `n` of the price to the payee, the rest of the vault to the payer
//!   2 reclaim  after `refund_after`, the payer alone takes everything but the fee back
//!   3 claim    a party whose share couldn't be paid (closed, frozen or wrong account) collects it later
//!   4 hold     given the arbiter's signature over `settle/v2|<program>|<escrow>|hold-until:<t>`,
//!              pushes `refund_after` back while a dispute is being decided
//!
//! Nobody else can lock an escrow: a share whose account is unusable becomes an amount owed (pull payment);
//! tokens deposited into the vault go to the payer; a broken fee account forfeits the fee to the payer.
//! An escrow account is never closed, so its address can't be reused and signatures can't be replayed.

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

pub const VERSION: u8 = 2;
pub const ESCROW_LEN: usize = 320;
const TOKEN_ACCOUNT_LEN: usize = 165;
/// How far ahead the arbiter may push a reclaim deadline in one hold.
const MAX_HOLD_SECONDS: i64 = 180 * 86_400;

pub const STATE_FUNDED: u8 = 1;
pub const STATE_RESOLVED: u8 = 2;
pub const STATE_RECLAIMED: u8 = 3;

#[repr(u32)]
pub enum SettleError {
    BadInstruction = 1,
    BadAccount = 2,
    NotFunded = 3,
    NoQuorum = 4,
    TooEarly = 5,
    BadAmount = 6,
    WrongTokenAccount = 7,
    NothingOwed = 8,
}
impl From<SettleError> for ProgramError {
    fn from(e: SettleError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub struct Escrow {
    pub version: u8,
    pub state: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub threshold: u8,
    pub fee_bps: u16,
    pub terms_hash: [u8; 32],
    pub mint: Pubkey,
    pub amount: u64,
    pub fee: u64,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub arbiter: Pubkey,
    pub fee_account: Pubkey,
    pub rent_payer: Pubkey,
    pub refund_after: i64,
    pub payee_paid: u64,
    pub evidence_hash: [u8; 32],
    pub payee_owed: u64,
    pub payer_owed: u64,
}

impl Escrow {
    fn read(d: &[u8]) -> Result<Self, ProgramError> {
        if d.len() < ESCROW_LEN || d[0] != VERSION {
            return Err(SettleError::BadAccount.into());
        }
        let pk = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
        let arr = |o: usize| -> [u8; 32] { d[o..o + 32].try_into().unwrap() };
        let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        Ok(Escrow {
            version: d[0],
            state: d[1],
            bump: d[2],
            vault_bump: d[3],
            threshold: d[4],
            fee_bps: u16::from_le_bytes([d[5], d[6]]),
            terms_hash: arr(8),
            mint: pk(40),
            amount: u(72),
            fee: u(80),
            payer: pk(88),
            payee: pk(120),
            arbiter: pk(152),
            fee_account: pk(184),
            rent_payer: pk(216),
            refund_after: i64::from_le_bytes(d[248..256].try_into().unwrap()),
            payee_paid: u(256),
            evidence_hash: arr(264),
            payee_owed: u(296),
            payer_owed: u(304),
        })
    }

    fn write(&self, d: &mut [u8]) {
        d[0] = self.version;
        d[1] = self.state;
        d[2] = self.bump;
        d[3] = self.vault_bump;
        d[4] = self.threshold;
        d[5..7].copy_from_slice(&self.fee_bps.to_le_bytes());
        d[8..40].copy_from_slice(&self.terms_hash);
        d[40..72].copy_from_slice(self.mint.as_ref());
        d[72..80].copy_from_slice(&self.amount.to_le_bytes());
        d[80..88].copy_from_slice(&self.fee.to_le_bytes());
        d[88..120].copy_from_slice(self.payer.as_ref());
        d[120..152].copy_from_slice(self.payee.as_ref());
        d[152..184].copy_from_slice(self.arbiter.as_ref());
        d[184..216].copy_from_slice(self.fee_account.as_ref());
        d[216..248].copy_from_slice(self.rent_payer.as_ref());
        d[248..256].copy_from_slice(&self.refund_after.to_le_bytes());
        d[256..264].copy_from_slice(&self.payee_paid.to_le_bytes());
        d[264..296].copy_from_slice(&self.evidence_hash);
        d[296..304].copy_from_slice(&self.payee_owed.to_le_bytes());
        d[304..312].copy_from_slice(&self.payer_owed.to_le_bytes());
    }

    fn seeds(&self) -> [&[u8]; 4] {
        [b"escrow", self.payer.as_ref(), &self.terms_hash, std::slice::from_ref(&self.bump)]
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => open(program_id, accounts, &data[1..]),
        Some(1) => resolve(program_id, accounts, &data[1..]),
        Some(2) => reclaim(program_id, accounts),
        Some(3) => claim(program_id, accounts),
        Some(4) => hold(program_id, accounts, &data[1..]),
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

/// Whether `acc` is a usable SPL token account of `mint`, held by `owner` if given: owned by the token
/// program, initialized and not frozen. Payouts to an unusable account become amounts owed instead.
fn usable_token_account(acc: &AccountInfo, mint: &Pubkey, owner: Option<&Pubkey>) -> bool {
    if acc.owner != &TOKEN_PROGRAM_ID {
        return false;
    }
    let Ok(d) = acc.try_borrow_data() else { return false };
    if d.len() < TOKEN_ACCOUNT_LEN || &d[0..32] != mint.as_ref() || d[108] != 1 {
        return false;
    }
    owner.map_or(true, |o| &d[32..64] == o.as_ref())
}

fn token_balance(acc: &AccountInfo) -> Result<u64, ProgramError> {
    let d = acc.try_borrow_data()?;
    if acc.owner != &TOKEN_PROGRAM_ID || d.len() < TOKEN_ACCOUNT_LEN {
        return Err(SettleError::BadAccount.into());
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

fn token_transfer<'a>(
    token_program: &AccountInfo<'a>,
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    seeds: Option<&[&[u8]]>,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
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
/// `create_account`.
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

/// The message signers sign to approve an outcome (design §5).
pub fn outcome_message(program_id: &Pubkey, escrow: &Pubkey, payee_amount: u64, evidence_hash: &[u8; 32]) -> Vec<u8> {
    format!("settle/v2|{}|{}|pay:{}|evidence:{}", program_id, escrow, payee_amount, hex(evidence_hash)).into_bytes()
}

/// The message the arbiter signs to hold off a reclaim while it decides a dispute.
pub fn hold_message(program_id: &Pubkey, escrow: &Pubkey, until: i64) -> Vec<u8> {
    format!("settle/v2|{}|{}|hold-until:{}", program_id, escrow, until).into_bytes()
}

/// Which of `keys` signed `expected`, according to Ed25519 precompile instructions earlier in this
/// transaction. Only signatures whose key, signature and message sit inside the precompile instruction's
/// own data count.
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

/// Pays `amount` from the vault to `dest` if it's usable for `owner`; otherwise returns it as still owed.
fn pay_or_owe<'a>(token_program: &AccountInfo<'a>, vault: &AccountInfo<'a>, dest: &AccountInfo<'a>, escrow: &AccountInfo<'a>, s: &Escrow, owner: &Pubkey, amount: u64) -> Result<u64, ProgramError> {
    if amount == 0 {
        return Ok(0);
    }
    if !usable_token_account(dest, &s.mint, Some(owner)) {
        msg!("settle: {} owed to {} (no usable token account given)", amount, owner);
        return Ok(amount);
    }
    token_transfer(token_program, vault, dest, escrow, amount, Some(&s.seeds()))?;
    Ok(0)
}

/// The fee goes to the agreed fee account if it's usable. If the processor broke it, the fee goes to the payer:
/// the processor can't hold anyone's payout hostage through its own account.
fn pay_fee<'a>(token_program: &AccountInfo<'a>, vault: &AccountInfo<'a>, fee_token: &AccountInfo<'a>, escrow: &AccountInfo<'a>, s: &Escrow) -> Result<u64, ProgramError> {
    if fee_token.key != &s.fee_account {
        return Err(SettleError::BadAccount.into());
    }
    if s.fee == 0 {
        return Ok(0);
    }
    if usable_token_account(fee_token, &s.mint, None) {
        token_transfer(token_program, vault, fee_token, escrow, s.fee, Some(&s.seeds()))?;
        Ok(0)
    } else {
        msg!("settle: fee account unusable; the fee goes to the payer");
        Ok(s.fee)
    }
}

fn close_vault_if_settled<'a>(token_program: &AccountInfo<'a>, vault: &AccountInfo<'a>, rent_payer: &AccountInfo<'a>, escrow: &AccountInfo<'a>, s: &Escrow) -> ProgramResult {
    if s.payee_owed == 0 && s.payer_owed == 0 && token_balance(vault)? == 0 {
        token_close(token_program, vault, rent_payer, escrow, &s.seeds())?;
    }
    Ok(())
}

fn load_funded(program_id: &Pubkey, escrow: &AccountInfo) -> Result<Escrow, ProgramError> {
    if escrow.owner != program_id {
        return Err(SettleError::BadAccount.into());
    }
    let s = Escrow::read(&escrow.try_borrow_data()?)?;
    if s.state != STATE_FUNDED {
        return Err(SettleError::NotFunded.into());
    }
    Ok(s)
}

fn check_vault(program_id: &Pubkey, escrow: &AccountInfo, vault: &AccountInfo, s: &Escrow) -> ProgramResult {
    let vault_key = Pubkey::create_program_address(&[b"vault", escrow.key.as_ref(), &[s.vault_bump]], program_id)?;
    if vault.key != &vault_key {
        return Err(SettleError::BadAccount.into());
    }
    Ok(())
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
    // Three distinct keys, so one signature can never count twice.
    if amount == 0 || !(1..=3).contains(&threshold) || fee_bps > 10_000 || payer.key == &payee || payer.key == &arbiter || payee == arbiter {
        return Err(SettleError::BadInstruction.into());
    }
    if refund_after <= Clock::get()?.unix_timestamp {
        return Err(SettleError::BadInstruction.into());
    }
    // The payer's key is in the address, so nobody can front-run an open to squat on its terms.
    let (escrow_key, bump) = Pubkey::find_program_address(&[b"escrow", payer.key.as_ref(), &terms_hash], program_id);
    let (vault_key, vault_bump) = Pubkey::find_program_address(&[b"vault", escrow_key.as_ref()], program_id);
    if escrow.key != &escrow_key || vault.key != &vault_key {
        msg!("escrow or vault address doesn't match the payer and terms");
        return Err(SettleError::BadAccount.into());
    }
    if !usable_token_account(payer_token, mint.key, Some(payer.key)) || !usable_token_account(fee_account, mint.key, None) {
        return Err(SettleError::WrongTokenAccount.into());
    }

    let escrow_seeds: &[&[u8]] = &[b"escrow", payer.key.as_ref(), &terms_hash, &[bump]];
    let vault_seeds: &[&[u8]] = &[b"vault", escrow_key.as_ref(), &[vault_bump]];
    create_pda_account(rent_payer, escrow, system_program, ESCROW_LEN, program_id, escrow_seeds)?;
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
        version: VERSION,
        state: STATE_FUNDED,
        bump,
        vault_bump,
        threshold,
        fee_bps,
        terms_hash,
        mint: *mint.key,
        amount,
        fee,
        payer: *payer.key,
        payee,
        arbiter,
        fee_account: *fee_account.key,
        rent_payer: *rent_payer.key,
        refund_after,
        payee_paid: 0,
        evidence_hash: [0; 32],
        payee_owed: 0,
        payer_owed: 0,
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

    if token_program.key != &TOKEN_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    let mut s = load_funded(program_id, escrow)?;
    check_vault(program_id, escrow, vault, &s)?;
    if rent_payer.key != &s.rent_payer {
        return Err(SettleError::BadAccount.into());
    }
    if payee_amount > s.amount {
        return Err(SettleError::BadAmount.into());
    }

    let expected = outcome_message(program_id, escrow.key, payee_amount, &evidence_hash);
    let signed = signers_in_transaction(ixs, &expected, &[s.payer, s.payee, s.arbiter])?;
    let count = signed.iter().filter(|x| **x).count() as u8;
    if count < s.threshold {
        msg!("settle: {} of {} needed signatures", count, s.threshold);
        return Err(SettleError::NoQuorum.into());
    }

    // Whatever is in the vault beyond price + fee (someone sent extra) goes to the payer.
    let vault_total = token_balance(vault)?;
    let surplus = vault_total.saturating_sub(s.amount + s.fee);
    let fee_back = pay_fee(token_program, vault, fee_token, escrow, &s)?;
    let payer_share = s.amount - payee_amount + surplus + fee_back;
    let (payee, payer) = (s.payee, s.payer);
    s.payee_owed = pay_or_owe(token_program, vault, payee_token, escrow, &s, &payee, payee_amount)?;
    s.payer_owed = pay_or_owe(token_program, vault, payer_token, escrow, &s, &payer, payer_share)?;
    s.state = STATE_RESOLVED;
    s.payee_paid = payee_amount;
    s.evidence_hash = evidence_hash;
    close_vault_if_settled(token_program, vault, rent_payer, escrow, &s)?;
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: resolved {}: payee {}, fee {}, payer {}", escrow.key, payee_amount, s.fee - fee_back, payer_share);
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

    if token_program.key != &TOKEN_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    let mut s = load_funded(program_id, escrow)?;
    if !payer.is_signer || payer.key != &s.payer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if Clock::get()?.unix_timestamp <= s.refund_after {
        return Err(SettleError::TooEarly.into());
    }
    check_vault(program_id, escrow, vault, &s)?;
    if rent_payer.key != &s.rent_payer {
        return Err(SettleError::BadAccount.into());
    }
    let vault_total = token_balance(vault)?;
    let fee_back = pay_fee(token_program, vault, fee_token, escrow, &s)?;
    let payer_share = vault_total - (s.fee - fee_back);
    let payer_key = s.payer;
    s.payer_owed = pay_or_owe(token_program, vault, payer_token, escrow, &s, &payer_key, payer_share)?;
    s.state = STATE_RECLAIMED;
    close_vault_if_settled(token_program, vault, rent_payer, escrow, &s)?;
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: reclaimed {}", escrow.key);
    Ok(())
}

// ---------------------------------------------------------------- claim

fn claim(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let claimant = next_account_info(it)?;
    let escrow = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let to = next_account_info(it)?;
    let rent_payer = next_account_info(it)?;
    let token_program = next_account_info(it)?;

    if escrow.owner != program_id || token_program.key != &TOKEN_PROGRAM_ID {
        return Err(SettleError::BadAccount.into());
    }
    if !claimant.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut s = Escrow::read(&escrow.try_borrow_data()?)?;
    if s.state == STATE_FUNDED {
        return Err(SettleError::NothingOwed.into());
    }
    check_vault(program_id, escrow, vault, &s)?;
    if rent_payer.key != &s.rent_payer || !usable_token_account(to, &s.mint, Some(claimant.key)) {
        return Err(SettleError::WrongTokenAccount.into());
    }
    let amount = if claimant.key == &s.payee {
        std::mem::take(&mut s.payee_owed)
    } else if claimant.key == &s.payer {
        // The payer also takes anything deposited into the vault after resolution.
        let owed_to_payee = s.payee_owed;
        s.payer_owed = 0;
        token_balance(vault)?.saturating_sub(owed_to_payee)
    } else {
        return Err(SettleError::NothingOwed.into());
    };
    if amount == 0 {
        return Err(SettleError::NothingOwed.into());
    }
    token_transfer(token_program, vault, to, escrow, amount, Some(&s.seeds()))?;
    close_vault_if_settled(token_program, vault, rent_payer, escrow, &s)?;
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: {} claimed {}", claimant.key, amount);
    Ok(())
}

// ---------------------------------------------------------------- hold

fn hold(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let escrow = next_account_info(it)?;
    let ixs = next_account_info(it)?;
    let until = Reader { d: data, at: 0 }.i64()?;
    let mut s = load_funded(program_id, escrow)?;
    if until > Clock::get()?.unix_timestamp + MAX_HOLD_SECONDS {
        return Err(SettleError::BadInstruction.into());
    }
    let expected = hold_message(program_id, escrow.key, until);
    // Only the arbiter can hold.
    let signed = signers_in_transaction(ixs, &expected, &[s.arbiter, s.arbiter, s.arbiter])?;
    if !signed[0] {
        return Err(SettleError::NoQuorum.into());
    }
    if until > s.refund_after {
        s.refund_after = until;
    }
    s.write(&mut escrow.try_borrow_mut_data()?);
    msg!("settle: {} held until {}", escrow.key, s.refund_after);
    Ok(())
}
