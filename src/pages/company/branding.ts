/**
 * Company branding — applies the ACTIVE company's `branding` to the app at
 * runtime by setting CSS variables on `:root`.
 *
 * INTEGRATION NOTE: `useCompanyBranding()` is currently called by the
 * Company Setup page (so branding applies when visiting /company). The
 * integration agent SHOULD mount it once app-wide (e.g. in AppLayout) so the
 * active company's accent applies on every page and survives navigation:
 *
 *   import { useCompanyBranding } from '@/pages/company/branding';
 *   // inside the root layout component:
 *   useCompanyBranding();
 *
 * Variables written (all on document.documentElement):
 *   --company-accent            raw hex, e.g. '#b45309' — for arbitrary consumers
 *   --company-accent-foreground readable foreground hex for text on the accent
 *   --primary / --ring          full-strength accent (HSL triplet, shadcn format)
 *   --primary-foreground        readable foreground (HSL triplet)
 *   --accent                    soft tint of the accent (HSL triplet)
 *   --accent-foreground         dark shade of the accent hue (HSL triplet)
 *
 * shadcn theme variables are HSL triplets WITHOUT the hsl() wrapper
 * (e.g. "32 85% 38%"), so the hex branding color is converted before writing.
 */
import { useEffect } from 'react';
import { useTenant } from '@/lib/tenantContext';
import type { CompanyBranding } from '@/lib/types';

export interface Hsl {
  h: number; // 0–360
  s: number; // 0–100
  l: number; // 0–100
}

/** Parse '#rrggbb' (or '#rgb') to an HSL triple. Returns null on bad input. */
export function hexToHsl(hex: string): Hsl | null {
  const m = hex.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let raw = m[1]!;
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** shadcn variable value, e.g. "32 85% 38%". */
export function hslVar({ h, s, l }: Hsl): string {
  return `${h} ${s}% ${l}%`;
}

/** Readable foreground for a fill of the given lightness. */
export function readableForegroundHsl(fill: Hsl): Hsl {
  return fill.l >= 62
    ? { h: fill.h, s: Math.min(fill.s, 45), l: 18 }
    : { h: fill.h, s: Math.min(fill.s, 40), l: 98 };
}

/** Soft surface tint of the accent (mirrors the theme's light --accent role). */
function accentTint({ h, s }: Hsl): Hsl {
  return { h, s: Math.min(Math.max(s, 30), 60), l: 92 };
}

/** Dark shade of the accent hue for text on the soft tint. */
function accentShade({ h, s }: Hsl): Hsl {
  return { h, s: Math.min(Math.max(s, 35), 60), l: 26 };
}

/** Preset swatches offered by the branding studio (warm, low-saturation). */
export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Amber', hex: '#b45309' },
  { name: 'Terracotta', hex: '#c2410c' },
  { name: 'Olive', hex: '#4d7c0f' },
  { name: 'Teal', hex: '#0f766e' },
  { name: 'Cocoa', hex: '#7c4a2d' },
  { name: 'Plum', hex: '#9d174d' },
  { name: 'Slate', hex: '#475569' },
  { name: 'Steel', hex: '#0369a1' },
];

/**
 * Push a company's branding onto :root CSS variables. No-op (and no crash)
 * when the hex is invalid — the theme defaults stay in place.
 */
export function applyCompanyBranding(branding: CompanyBranding | null | undefined): void {
  if (!branding) return;
  const hsl = hexToHsl(branding.accentColor);
  if (!hsl) return;
  const root = document.documentElement.style;
  const fg = readableForegroundHsl(hsl);
  root.setProperty('--company-accent', branding.accentColor);
  root.setProperty('--company-accent-foreground', `hsl(${hslVar(fg)})`);
  root.setProperty('--primary', hslVar(hsl));
  root.setProperty('--primary-foreground', hslVar(fg));
  root.setProperty('--ring', hslVar(hsl));
  root.setProperty('--accent', hslVar(accentTint(hsl)));
  root.setProperty('--accent-foreground', hslVar(accentShade(hsl)));
  root.setProperty('--sidebar-primary', hslVar(hsl));
  root.setProperty('--sidebar-ring', hslVar(hsl));
}

/**
 * React hook — applies the ACTIVE company's branding whenever it changes
 * (including tenant switches). Intentionally does NOT restore the theme
 * defaults on unmount: the last active company's identity should persist
 * until another company becomes active.
 */
export function useCompanyBranding(): void {
  const { activeCompany } = useTenant();
  const logoText = activeCompany?.branding.logoText;
  const accentColor = activeCompany?.branding.accentColor;
  useEffect(() => {
    if (logoText === undefined && accentColor === undefined) return;
    applyCompanyBranding({ logoText: logoText ?? '', accentColor: accentColor ?? '' });
  }, [logoText, accentColor]);
}
