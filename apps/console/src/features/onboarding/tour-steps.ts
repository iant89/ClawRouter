import { visibleNavigation, type NavItem, type PageId } from '../../app/navigation.ts';

/** One step of the console tour, before it becomes an ENTERPRISE-UI TourStep. */
export interface ConsoleTourStep {
  id: string;
  title: string;
  text: string;
  /** CSS selector of what the step points at; none: centred. */
  target?: string;
  placement?: 'right' | 'bottom' | 'bottom-end' | 'left';
}

/** A sidebar link: the tour points at the page in the navigation, never opens it. */
export const navTarget = (item: NavItem) => `nav a[href="${item.path}"]`;

/** What each area of the console is for, in a sentence the tour can use. */
const AREA_TEXT: Record<string, (pages: PageId[]) => string> = {
  gateway: (pages) => [
    pages.includes('requests') ? 'Requests lists every call through the gateway, with each attempt, retry and failover.' : '',
    pages.includes('api-access') ? 'API Access holds the keys applications use.' : pages.includes('my-keys') ? 'My API keys holds your own keys, or a request for one.' : '',
    pages.includes('usage') ? 'Usage shows tokens and estimated cost by model, provider, key and user.' : '',
    pages.includes('rate-limits') ? 'Rate Limits keeps any one client from using it all.' : '',
  ].filter(Boolean).join(' '),
  ai: (pages) => [
    pages.includes('providers') ? 'Providers are the AI services ClawRouter sends requests to, with their keys and health.' : '',
    pages.includes('models') ? 'Models lists what each provider offers, with prices and capabilities.' : '',
    pages.includes('routing') ? 'Routing decides where a request goes and what to try when a provider fails.' : '',
  ].filter(Boolean).join(' '),
  system: (pages) => [
    pages.includes('health') ? 'Health shows each part of the platform, with its history.' : '',
    pages.includes('operations') ? 'Operations tracks longer jobs such as connection tests.' : '',
    pages.includes('logs') && pages.includes('audit') ? 'Logs and Audit record what happened and who did it.'
      : pages.includes('logs') ? 'Logs records what the server did.'
        : pages.includes('audit') ? 'Audit records who did what, and when.' : '',
    pages.includes('captures') ? 'Captures keeps the full exchange of requests a provider got wrong, to export for a developer (turned on in Settings).' : '',
  ].filter(Boolean).join(' '),
  admin: (pages) => [
    pages.includes('users') || pages.includes('roles') ? 'Users and Roles decide who can do what.' : '',
    pages.includes('sessions') ? 'Sessions shows who is signed in.' : '',
    pages.includes('settings') ? 'Settings holds sign-in security, the mail server, retention and configuration export.' : '',
  ].filter(Boolean).join(' '),
};

const AREA_TITLE: Record<string, string> = { gateway: 'The gateway', ai: 'AI infrastructure', system: 'Keeping an eye on it', admin: 'Administration' };

/**
 * The guided tour for one user (owner request, 2026-11-16): a welcome, then one
 * step per area of the console this user can open, pointing at its first page
 * in the navigation and describing only the pages they can see, then the
 * header, and where to replay it. A Viewer gets a shorter tour than an
 * administrator; nothing they cannot open is mentioned.
 */
export function tourSteps(permissions: ReadonlySet<string>, displayName: string): ConsoleTourStep[] {
  const groups = visibleNavigation(permissions);
  const steps: ConsoleTourStep[] = [
    {
      id: 'welcome',
      title: `Welcome to ClawRouter, ${displayName}`,
      text: 'ClawRouter sits between your applications and AI providers: one API in front of all of them, with routing, failover, limits and usage tracking. This short tour shows where things are. Skip it at any time.',
    },
  ];
  const home = groups.find((g) => g.id === 'home')?.items[0];
  if (home) steps.push({ id: 'dashboard', title: 'Dashboard', text: 'The answer to "is the gateway working?": platform health, live traffic, errors and latency.', target: navTarget(home), placement: 'right' });
  for (const group of groups) {
    const text = AREA_TEXT[group.id]?.(group.items.map((i) => i.id));
    if (!text || !group.items[0]) continue;
    steps.push({ id: group.id, title: AREA_TITLE[group.id] ?? group.label ?? group.id, text, target: navTarget(group.items[0]), placement: 'right' });
  }
  steps.push(
    { id: 'health', title: 'System health, everywhere', text: 'The header always shows the system health and whether the console is live. It changes as soon as something does.', target: '[data-tour="health"]', placement: 'bottom' },
    { id: 'notifications', title: 'Notifications', text: 'Problems, finished operations and requests that need you (such as API key requests) arrive here.', target: 'header button[aria-label^="Notifications"]', placement: 'bottom-end' },
    { id: 'help', title: 'Help', text: permissions.has('settings.write') ? 'Take this tour again, or run the setup wizard again, from the help menu (? in the header; under More on a small screen).' : 'Take this tour again from the help menu (? in the header; under More on a small screen).', target: 'header button[aria-label="Help"]', placement: 'bottom-end' },
  );
  return steps;
}
