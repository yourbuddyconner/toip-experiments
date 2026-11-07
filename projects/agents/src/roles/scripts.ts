/**
 * Scripts for the scripted model, one per demo role and session (design §12.1). They drive the same tools a
 * live model would, deterministically, so the demo and the tests run without an API key.
 */
import type { Script, ScriptContext, Step } from "../loop/scripted";

const quoteFrom = (ctx: ScriptContext, name: string) => ctx.event((e) => e.type === "quote" && e.quote?.from?.name === name)?.quote;
const workerDid = (ctx: ScriptContext, name: string): string => (ctx.result("find_workers") ?? []).find?.((w: { name: string }) => w.name === name)?.did ?? name;
const jobOf = (ctx: ScriptContext, name: string): string | undefined => {
  const did = workerDid(ctx, name);
  for (const r of ctx.results) if (r.tool === "offer_job" && r.input.worker === did && r.result?.ok) return r.result.value.job;
  return undefined;
};
const wait = (seconds = 5) => [{ name: "inbox", input: { waitSeconds: seconds } }];

export const FIXED_INVOICE = `// Invoice totals, in cents.

export function lineTotal(item) {
  return item.price * item.quantity;
}

export function total(items) {
  let sum = 0;
  for (const item of items) sum += lineTotal(item);
  return sum;
}
`;

export const BROKEN_FIX = FIXED_INVOICE.replace("item.price * item.quantity", "item.price + item.quantity");

export function opsScript(): Script {
  const steps: Step[] = [
    { name: "whoami", call: () => [{ name: "whoami", input: {} }] },
    { name: "find coders", call: () => [{ name: "find_workers", input: { skill: "software" } }] },
    {
      name: "offer the fix",
      call: (ctx) =>
        ["Coder agent", "QuickFix"].map((w) => ({
          name: "offer_job",
          input: {
            worker: workerDid(ctx, w),
            title: "Fix the failing test in demo-repo",
            description: "node --test fails in demo-repo: invoice totals ignore the quantity. Fix it and deliver a commit; CI confirms.",
            category: "software.tests",
            maxPrice: "30",
            release: "ci",
            disputeWindowDays: 0,
          },
        })),
    },
    { name: "wait for quotes", call: () => wait(5), until: (ctx) => !!quoteFrom(ctx, "Coder agent") && !!quoteFrom(ctx, "QuickFix"), maxRepeats: 40 },
    {
      name: "check both quotes",
      call: (ctx) => [quoteFrom(ctx, "Coder agent"), quoteFrom(ctx, "QuickFix")].filter(Boolean).map((q) => ({ name: "check_mandate", input: { quote: q.id } })),
    },
    {
      name: "hire Coder",
      call: (ctx) => [{ name: "hire", input: { quote: quoteFrom(ctx, "Coder agent").id, justification: "Coder agent is verified and its 20 USDC quote is within my limits; CI confirms the fix." } }],
    },
    {
      name: "delegate the errand",
      call: () => [
        {
          name: "delegate",
          input: {
            subAgent: "Errands agent",
            purpose: "Small physical errands for Conner Swann",
            task: "Pick up the parcel waiting at the Main St post office and bring it to Conner Swann.",
            perPayment: "30",
            perDay: "60",
            total: "60",
            categories: ["physical.errand"],
            validDays: 1,
            funding: "60",
          },
        },
      ],
    },
    { name: "report", call: () => [{ name: "report", input: { text: "Hired Coder agent to fix CI (20 USDC, CI confirms). Refused QuickFix's quote. Delegated the parcel errand to Errands agent with 60 USDC." } }] },
    {
      name: "wait for CI and settlement",
      call: () => wait(5),
      until: (ctx) => {
        const job = jobOf(ctx, "Coder agent");
        return !!ctx.event((e) => e.type === "payment" && e.job === job && String(e.status).startsWith("settled"));
      },
      maxRepeats: 120,
    },
    { name: "finish", call: () => [{ name: "finish", input: { summary: "CI is green: Coder agent's fix passed and was paid. The parcel errand is with Errands agent." } }] },
  ];
  return { name: "ops", steps };
}

export function errandsScript(): Script {
  const danaQuote = (ctx: ScriptContext) => ctx.event((e) => e.type === "quote")?.quote;
  const steps: Step[] = [
    { name: "whoami", call: () => [{ name: "whoami", input: {} }] },
    { name: "find couriers", call: () => [{ name: "find_workers", input: { skill: "courier" } }] },
    {
      name: "offer the errand",
      call: (ctx) => [
        {
          name: "offer_job",
          input: {
            worker: (ctx.result("find_workers") ?? [])[0]?.did ?? "Dana Ruiz",
            title: "Bring the parcel from the Main St post office",
            description: "A parcel for Conner Swann is waiting at the Main St post office. Pick it up and bring it to his door.",
            category: "physical.errand",
            maxPrice: "50",
            release: "principal",
            disputeWindowDays: 0,
          },
        },
      ],
    },
    { name: "wait for a quote", call: () => wait(5), until: (ctx) => !!danaQuote(ctx), maxRepeats: 120 },
    { name: "hire", call: (ctx) => [{ name: "hire", input: { quote: danaQuote(ctx).id, justification: "Dana is a verified courier; 45 USDC is a fair price for a same-day parcel pickup." } }] },
    {
      name: "wait for the principal",
      call: () => wait(5),
      until: (ctx) => !!ctx.event((e) => e.type === "approval" && ["granted", "denied", "lapsed"].includes(e.status)) || ctx.result("hire")?.status === "hired",
      maxRepeats: 240,
    },
    { name: "wait for delivery", call: () => wait(5), until: (ctx) => !!ctx.event((e) => e.type === "delivered"), maxRepeats: 240 },
    { name: "report", call: () => [{ name: "report", input: { text: "Dana says the parcel is at your door. Please confirm you received it, so she is paid." } }] },
    { name: "wait for settlement", call: () => wait(5), until: (ctx) => !!ctx.event((e) => e.type === "payment" && String(e.status).startsWith("settled")), maxRepeats: 240 },
    { name: "finish", call: () => [{ name: "finish", input: { summary: "The parcel was delivered and Dana was paid." } }] },
  ];
  return { name: "errands", steps };
}

/** After revocation: the agent tries another errand, and the guard refuses. */
export function errandsAgainScript(): Script {
  return {
    name: "errands-2",
    steps: [
      { call: () => [{ name: "find_workers", input: { skill: "courier" } }] },
      {
        call: (ctx) => [
          {
            name: "offer_job",
            input: {
              worker: (ctx.result("find_workers") ?? [])[0]?.did ?? "Dana Ruiz",
              title: "Pick up dry cleaning on Elm St",
              description: "Dry cleaning for Conner Swann, ready at the Elm St cleaners.",
              category: "physical.errand",
              maxPrice: "20",
              release: "principal",
              disputeWindowDays: 0,
            },
          },
        ],
      },
      { call: (ctx) => [{ name: "report", input: { text: `I couldn't take the errand: ${(ctx.result("offer_job")?.refused?.sentences ?? [ctx.result("offer_job")?.error ?? "refused"])[0]}` } }] },
      { call: () => [{ name: "finish", input: { summary: "Refused: my mandate is no longer valid." } }] },
    ],
  };
}

export function coderScript(o: { brokenFirst?: boolean } = {}): Script {
  const offer = (ctx: ScriptContext) => ctx.event((e) => e.type === "offer" && e.hirerVerified);
  const job = (ctx: ScriptContext) => offer(ctx)?.job;
  const status = (ctx: ScriptContext, pred: (s: string) => boolean) => !!ctx.event((e) => e.type === "payment" && e.job === job(ctx) && pred(String(e.status)));
  const fix = (text: string): Step[] => [
    { name: "read", call: () => [{ name: "read_file", input: { path: "src/invoice.js" } }] },
    { name: "fix", call: () => [{ name: "write_file", input: { path: "src/invoice.js", text } }] },
    { name: "test", call: () => [{ name: "run_tests", input: {} }] },
    { name: "deliver", call: (ctx) => [{ name: "deliver", input: { job: job(ctx), note: "lineTotal now multiplies by the quantity." } }] },
  ];
  const steps: Step[] = [
    { name: "wait for an offer", call: () => wait(5), until: (ctx) => !!offer(ctx), maxRepeats: 120 },
    { name: "quote", call: (ctx) => [{ name: "quote", input: { job: job(ctx), price: "20", note: "Happy to help, I can have it fixed in a few minutes." } }] },
    { name: "wait for escrow", call: () => wait(5), until: (ctx) => status(ctx, (s) => s === "paid into escrow"), maxRepeats: 120 },
    ...(o.brokenFirst
      ? [...fix(BROKEN_FIX), { name: "wait for CI", call: () => wait(5), until: (ctx: ScriptContext) => status(ctx, (s) => s.includes("not-complete")), maxRepeats: 120 } as Step]
      : []),
    ...fix(FIXED_INVOICE),
    { name: "wait for payment", call: () => wait(5), until: (ctx) => status(ctx, (s) => s.startsWith("settled")), maxRepeats: 120 },
    { name: "finish", call: () => [{ name: "finish", input: { summary: "Fixed the invoice totals; CI passed and the escrow paid out." } }] },
  ];
  return { name: o.brokenFirst ? "coder-broken-first" : "coder", steps };
}
