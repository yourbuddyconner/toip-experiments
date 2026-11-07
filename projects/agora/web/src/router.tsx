/** A small router over the History API. */
import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const EVENT = "agora:navigate";

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  dispatchEvent(new Event(EVENT));
  window.scrollTo(0, 0);
  // Move focus to the new page's heading, for screen readers and keyboards.
  requestAnimationFrame(() => document.querySelector<HTMLElement>("main h1")?.focus());
}

function subscribe(fn: () => void) {
  addEventListener("popstate", fn);
  addEventListener(EVENT, fn);
  return () => {
    removeEventListener("popstate", fn);
    removeEventListener(EVENT, fn);
  };
}

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => location.pathname + location.search);
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export const forumPath = (forumId: string) => `/f/${forumId.replace(/^urn:uuid:/, "")}`;
export const threadPath = (forumId: string, threadId: string) => `${forumPath(forumId)}/t/${threadId.replace(/^urn:uuid:/, "")}`;
export const moderatePath = (forumId: string) => `/moderate/${forumId.replace(/^urn:uuid:/, "")}`;
export const urn = (uuid: string) => `urn:uuid:${uuid}`;
