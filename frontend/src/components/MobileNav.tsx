export type MobileTab = "style" | "subs" | "timeline" | "export";

type TabDef = { key: MobileTab; label: string; icon: string };

const TABS: TabDef[] = [
  { key: "style", label: "Style", icon: "palette" },
  { key: "subs", label: "Subs", icon: "subs" },
  { key: "timeline", label: "Timeline", icon: "timeline" },
  { key: "export", label: "Export", icon: "export" },
];

function NavIcon({ icon }: { icon: string }) {
  switch (icon) {
    case "palette":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
          <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
          <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
          <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
          <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
        </svg>
      );
    case "subs":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M7 12h2" />
          <path d="M15 12h2" />
          <path d="M7 16h10" />
        </svg>
      );
    case "timeline":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="2" y1="12" x2="22" y2="12" />
          <polyline points="6 8 2 12 6 16" />
          <polyline points="18 8 22 12 18 16" />
        </svg>
      );
    case "export":
      return (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      );
    default:
      return null;
  }
}

export function MobileNav({
  active,
  onChange,
}: {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}) {
  return (
    <nav className="mobile-nav" data-testid="mobile-nav">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          className={`mobile-nav-btn${active === tab.key ? " active" : ""}`}
          data-testid={`mobile-tab-${tab.key}`}
          onClick={() => onChange(tab.key)}
        >
          <NavIcon icon={tab.icon} />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
