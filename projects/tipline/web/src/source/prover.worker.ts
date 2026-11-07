// Proves membership off the page's main thread. The CRS is bundled with the library: nothing is fetched.
import { serveMembershipWorker } from "@toip-tools/anon-membership/worker";

serveMembershipWorker();
