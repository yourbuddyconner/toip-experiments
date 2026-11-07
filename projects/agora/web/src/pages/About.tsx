/** What this client is, what it proves, and what it leaks. */
import { useApp } from "../state";

declare const __BUILD_ID__: string;

export function AboutPage() {
  const { services } = useApp();
  return (
    <section className="narrow">
      <h1 tabIndex={-1}>About this client</h1>
      <p className="lede">Agora's client holds your secret, so it comes from somewhere other than the forum host. Compare its build with a published one before you trust it.</p>
      <dl className="facts">
        <div>
          <dt>Build</dt>
          <dd>
            <code className="mono" data-testid="build">
              {__BUILD_ID__}
            </code>
          </dd>
        </div>
        <div>
          <dt>Forum host</dt>
          <dd>
            {services?.config.hostUrl} <code className="did">{services?.config.host.did}</code>
          </dd>
        </div>
        <div>
          <dt>Cross-origin isolated</dt>
          <dd>{typeof crossOriginIsolated !== "undefined" && crossOriginIsolated ? "Yes: the prover can use several threads." : "No: the prover runs on one thread."}</dd>
        </div>
      </dl>
      <h2>What a post proves</h2>
      <p>
        A post's pass carries a zero-knowledge proof: "my leaf is in one of this forum's groups, my credential's attributes meet its rules, and this is my pseudonym here." The proof system is UltraHonk, in its zero-knowledge mode. It is designed to be zero-knowledge; we found no published proof that it is, and its makers say it isn't ready for production yet.
      </p>
      <h2>What it doesn't hide</h2>
      <ul>
        <li>The host sees your network address unless you use Tor or a VPN. This host promises not to keep addresses, and keeps no request logs.</li>
        <li>Your writing style can identify you.</li>
        <li>Posting right after you join a group narrows who you are. So can a small group, or a narrow rule.</li>
        <li>Groups know which accounts joined them. They can't tell which member wrote anything.</li>
      </ul>
    </section>
  );
}
