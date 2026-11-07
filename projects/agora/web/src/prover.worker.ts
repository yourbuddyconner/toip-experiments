// Proves and verifies in a Web Worker, so the page stays responsive.
import { serveMembershipWorker } from "@zk-toip/anon-membership/worker";

serveMembershipWorker();
