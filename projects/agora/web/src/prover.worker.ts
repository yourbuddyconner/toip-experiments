// Proves and verifies in a Web Worker, so the page stays responsive.
import { serveMembershipWorker } from "@toip-tools/anon-membership/worker";

serveMembershipWorker();
