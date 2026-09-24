import Link from "next/link";

export interface SectionTab {
  key: string;
  label: string;
}

export function SectionTabs({
  baseUrl,
  tabs,
  active,
}: {
  baseUrl: string;
  tabs: SectionTab[];
  active: string;
}) {
  return (
    <div className="mb-6 inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
      {tabs.map((t, i) => {
        const href = i === 0 ? baseUrl : `${baseUrl}?tab=${t.key}`;
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={
              isActive
                ? "rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-semibold text-white"
                : "rounded-lg px-4 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
