import Link from "next/link";

const SMS_NAV = [
  { href: "/sms", label: "Dashboard" },
  { href: "/sms/campaigns", label: "Campaigns" },
  { href: "/sms/inbox", label: "Inbox" },
  { href: "/sms/contacts", label: "Contacts" },
  { href: "/sms/analytics", label: "Analytics" },
];

export default function SmsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav className="mb-6 flex flex-wrap items-center gap-1 border-b border-slate-200 pb-3" aria-label="SMS">
        {SMS_NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
