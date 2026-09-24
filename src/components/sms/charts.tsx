import React from "react";

export interface SeriesPoint {
  label: string;
  value: number;
}

function niceMax(max: number): number {
  if (max <= 5) return 5;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / pow) * pow;
}

/** Simple professional SVG line/area chart. */
export function LineChart({
  data,
  color = "#4f46e5",
  height = 220,
  ariaLabel,
}: {
  data: SeriesPoint[];
  color?: string;
  height?: number;
  ariaLabel: string;
}) {
  const width = 640;
  const pad = { top: 12, right: 12, bottom: 24, left: 36 };
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-slate-400">No data</p>;
  }
  const max = niceMax(Math.max(...data.map((d) => d.value), 1));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  const line = data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(d.value)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${pad.top + innerH} L${x(0)},${pad.top + innerH} Z`;
  const ticks = [0, max / 2, max];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
            {Math.round(t)}
          </text>
        </g>
      ))}
      <path d={area} fill={color} opacity="0.1" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {data.map((d, i) =>
        i % Math.ceil(data.length / 8) === 0 || i === data.length - 1 ? (
          <text key={d.label} x={x(i)} y={height - 6} textAnchor="middle" fontSize="10" fill="#94a3b8">
            {d.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/** Simple professional SVG bar chart. */
export function BarChart({
  data,
  color = "#4f46e5",
  height = 220,
  ariaLabel,
}: {
  data: SeriesPoint[];
  color?: string;
  height?: number;
  ariaLabel: string;
}) {
  const width = 640;
  const pad = { top: 12, right: 12, bottom: 24, left: 36 };
  if (data.length === 0) {
    return <p className="py-10 text-center text-sm text-slate-400">No data</p>;
  }
  const max = niceMax(Math.max(...data.map((d) => d.value), 1));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const slot = innerW / data.length;
  const barW = Math.min(slot * 0.65, 48);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke="#e2e8f0" strokeWidth="1" />
          <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
            {Math.round(t)}
          </text>
        </g>
      ))}
      {data.map((d, i) => {
        const bx = pad.left + slot * i + (slot - barW) / 2;
        const by = y(d.value);
        return (
          <g key={d.label}>
            <rect x={bx} y={by} width={barW} height={pad.top + innerH - by} rx="3" fill={color} opacity="0.85" />
            {(data.length <= 14 || i % Math.ceil(data.length / 14) === 0) && (
              <text x={bx + barW / 2} y={height - 6} textAnchor="middle" fontSize="10" fill="#94a3b8">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal bar list used for per-campaign comparisons. */
export function HBarList({
  data,
  color = "#4f46e5",
}: {
  data: SeriesPoint[];
  color?: string;
}) {
  if (data.length === 0) return <p className="py-10 text-center text-sm text-slate-400">No data</p>;
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3 text-sm">
          <span className="w-40 shrink-0 truncate text-slate-600" title={d.label}>{d.label}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${(d.value / max) * 100}%`, backgroundColor: color }}
            />
          </div>
          <span className="w-12 shrink-0 text-right font-medium text-slate-700">{d.value}%</span>
        </div>
      ))}
    </div>
  );
}
