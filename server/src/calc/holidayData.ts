/**
 * ⚠️ SYNC COPY — DO NOT EDIT IN PLACE.
 * Source of truth: hrms-web/src/lib/holidayData.ts
 * Re-sync with:  cd server && npm run sync-calc
 */
/**
 * Curated Malaysian public holidays 2025–2027 (national + per-state).
 *
 * Sources: docs/research/public-holidays.md §5.1 (2025, confirmed JPM calendar)
 * and §5.2 (2026 gazetted). 2027 dates are PROJECTED — fixed/civil dates are
 * reliable; Islamic (moon-sighting) and lunar-festival dates are marked
 * `tentative: true` until officially gazetted (JPM / Keeper of the Rulers' Seal).
 *
 * Coverage carve-outs encoded per research §1.2:
 *  - New Year's Day: NOT in JHR, KDH, KTN, PLS, TRG
 *  - Deepavali: NOT in SWK
 *  - Nuzul Al-Quran: NOT in JHR, KDH, MLK, NSB, SBH, SWK
 * Replacement (in-lieu) days are NOT baked in — computed per state by
 * `replacementHoliday()` in holidays.ts (weekend rules differ by state).
 */

import type { StateCode } from './types';

export interface HolidayDef {
  date: string; // 'YYYY-MM-DD'
  name: string;
  nameMs?: string;
  states: StateCode[] | 'ALL';
  except?: StateCode[];
  isCompulsoryEA?: boolean;
  tentative?: boolean;
}

const THAIPUSAM: StateCode[] = ['JHR', 'NSB', 'PRK', 'PNG', 'SGR', 'KUL', 'PJY'];
const NO_NEW_YEAR: StateCode[] = ['JHR', 'KDH', 'KTN', 'PLS', 'TRG'];
const NUZUL_EXCEPT: StateCode[] = ['JHR', 'KDH', 'MLK', 'NSB', 'SBH', 'SWK'];
const GOOD_FRIDAY: StateCode[] = ['SBH', 'SWK'];
const KAAMATAN: StateCode[] = ['SBH', 'LBN'];
const FT_DAY: StateCode[] = ['KUL', 'LBN', 'PJY'];
const AWAL_RAMADAN: StateCode[] = ['JHR', 'KDH'];
const ISRAK_MIKRAJ: StateCode[] = ['KDH', 'NSB', 'PLS', 'TRG'];

/** Fixed-date state/territory days reused across years (rulers' birthdays etc.). */
function fixedStateDays(year: number): HolidayDef[] {
  return [
    { date: `${year}-01-14`, name: "Yang di-Pertuan Besar of Negeri Sembilan's Birthday", states: ['NSB'], isCompulsoryEA: true },
    { date: `${year}-02-01`, name: 'Federal Territory Day', nameMs: 'Hari Wilayah Persekutuan', states: FT_DAY, isCompulsoryEA: true },
    { date: `${year}-02-20`, name: 'Melaka Independence Declaration Day', states: ['MLK'] },
    { date: `${year}-03-23`, name: "Sultan of Johor's Birthday", states: ['JHR'], isCompulsoryEA: true },
    { date: `${year}-04-26`, name: "Sultan of Terengganu's Birthday", states: ['TRG'], isCompulsoryEA: true },
    { date: `${year}-05-17`, name: "Raja of Perlis's Birthday", states: ['PLS'], isCompulsoryEA: true },
    { date: `${year}-05-22`, name: 'Hari Hol Pahang', states: ['PHG'] },
    { date: `${year}-05-30`, name: 'Harvest Festival (Kaamatan) Day 1', states: KAAMATAN },
    { date: `${year}-05-31`, name: 'Harvest Festival (Kaamatan) Day 2', states: KAAMATAN },
    { date: `${year}-06-01`, name: 'Gawai Dayak Day 1', states: ['SWK'] },
    { date: `${year}-06-02`, name: 'Gawai Dayak Day 2', states: ['SWK'] },
    { date: `${year}-07-07`, name: 'Georgetown UNESCO Heritage Day', states: ['PNG'] },
    { date: `${year}-07-22`, name: 'Sarawak Day', states: ['SWK'] },
    { date: `${year}-07-30`, name: "Sultan of Pahang's Birthday", states: ['PHG'], isCompulsoryEA: true },
    { date: `${year}-08-24`, name: "Melaka Governor's Birthday", states: ['MLK'], isCompulsoryEA: true },
    { date: `${year}-09-29`, name: "Sultan of Kelantan's Birthday Day 1", states: ['KTN'], isCompulsoryEA: true },
    { date: `${year}-09-30`, name: "Sultan of Kelantan's Birthday Day 2", states: ['KTN'] },
    { date: `${year}-12-11`, name: "Sultan of Selangor's Birthday", states: ['SGR'], isCompulsoryEA: true },
    { date: `${year}-12-24`, name: 'Christmas Eve', states: ['SBH'] },
  ];
}

/** nth weekday of month → ISO date. weekday: 0=Sun … 6=Sat. */
function nthWeekday(year: number, month1: number, weekday: number, n: number): string {
  const first = new Date(year, month1 - 1, 1);
  const offset = (weekday - first.getDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const HOLIDAY_DATA: Record<number, HolidayDef[]> = {
  // ── 2025: confirmed JPM calendar (research §5.1) ──────────────────────────
  2025: [
    { date: '2025-01-01', name: "New Year's Day", states: 'ALL', except: NO_NEW_YEAR },
    { date: '2025-01-29', name: 'Chinese New Year', states: 'ALL' },
    { date: '2025-01-30', name: 'Chinese New Year Day 2', states: 'ALL' },
    { date: '2025-03-18', name: 'Nuzul Al-Quran', states: 'ALL', except: NUZUL_EXCEPT, tentative: true },
    { date: '2025-03-31', name: 'Hari Raya Aidilfitri', states: 'ALL', tentative: true },
    { date: '2025-04-01', name: 'Hari Raya Aidilfitri Day 2', states: 'ALL', tentative: true },
    { date: '2025-05-01', name: 'Labour Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2025-05-12', name: 'Wesak Day', states: 'ALL' },
    { date: '2025-06-02', name: "Yang di-Pertuan Agong's Birthday", states: 'ALL', isCompulsoryEA: true },
    { date: '2025-06-07', name: 'Hari Raya Haji', states: 'ALL', tentative: true },
    { date: '2025-06-27', name: 'Awal Muharram', states: 'ALL', tentative: true },
    { date: '2025-08-31', name: 'National Day (Merdeka)', states: 'ALL', isCompulsoryEA: true },
    { date: '2025-09-05', name: 'Maulidur Rasul', states: 'ALL', tentative: true },
    { date: '2025-09-16', name: 'Malaysia Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2025-10-20', name: 'Deepavali', states: 'ALL', except: ['SWK'] },
    { date: '2025-12-25', name: 'Christmas Day', states: 'ALL' },
    // State-only (research §5.1)
    { date: '2025-01-27', name: 'Israk Mikraj', states: ISRAK_MIKRAJ, tentative: true },
    { date: '2025-02-11', name: 'Thaipusam', states: THAIPUSAM },
    { date: '2025-03-02', name: 'Awal Ramadan', states: AWAL_RAMADAN, tentative: true },
    { date: '2025-04-18', name: 'Good Friday', states: GOOD_FRIDAY },
    { date: '2025-06-15', name: "Sultan of Kedah's Birthday", states: ['KDH'], isCompulsoryEA: true },
    { date: '2025-07-12', name: "Penang Governor's Birthday", states: ['PNG'], isCompulsoryEA: true },
    { date: '2025-07-31', name: 'Hari Hol Almarhum Sultan Iskandar', states: ['JHR'] },
    { date: '2025-10-04', name: "Sabah Governor's Birthday", states: ['SBH'], isCompulsoryEA: true },
    { date: '2025-10-11', name: "Sarawak Governor's Birthday", states: ['SWK'], isCompulsoryEA: true },
    { date: '2025-11-07', name: "Sultan of Perak's Birthday", states: ['PRK'], isCompulsoryEA: true },
    ...fixedStateDays(2025),
  ],

  // ── 2026: gazetted (research §5.2); Islamic dates pending official confirmation ──
  2026: [
    { date: '2026-01-01', name: "New Year's Day", states: 'ALL', except: NO_NEW_YEAR },
    { date: '2026-02-17', name: 'Chinese New Year', states: 'ALL' },
    { date: '2026-02-18', name: 'Chinese New Year Day 2', states: 'ALL' },
    { date: '2026-03-07', name: 'Nuzul Al-Quran', states: 'ALL', except: NUZUL_EXCEPT, tentative: true },
    { date: '2026-03-21', name: 'Hari Raya Aidilfitri', states: 'ALL', tentative: true },
    { date: '2026-03-22', name: 'Hari Raya Aidilfitri Day 2', states: 'ALL', tentative: true },
    { date: '2026-05-01', name: 'Labour Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2026-05-31', name: 'Wesak Day', states: 'ALL' },
    { date: '2026-06-01', name: "Yang di-Pertuan Agong's Birthday", states: 'ALL', isCompulsoryEA: true },
    { date: '2026-05-27', name: 'Hari Raya Haji', states: 'ALL', tentative: true },
    { date: '2026-06-17', name: 'Awal Muharram', states: 'ALL', tentative: true },
    { date: '2026-08-31', name: 'National Day (Merdeka)', states: 'ALL', isCompulsoryEA: true },
    { date: '2026-08-25', name: 'Maulidur Rasul', states: 'ALL', tentative: true },
    { date: '2026-09-16', name: 'Malaysia Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2026-11-08', name: 'Deepavali', states: 'ALL', except: ['SWK'] },
    { date: '2026-12-25', name: 'Christmas Day', states: 'ALL' },
    // State-only (research §5.2)
    { date: '2026-01-17', name: 'Israk Mikraj', states: ISRAK_MIKRAJ, tentative: true },
    { date: '2026-02-01', name: 'Thaipusam', states: THAIPUSAM },
    { date: '2026-02-19', name: 'Awal Ramadan', states: AWAL_RAMADAN, tentative: true },
    { date: '2026-04-03', name: 'Good Friday', states: GOOD_FRIDAY },
    { date: '2026-06-21', name: "Sultan of Kedah's Birthday", states: ['KDH'], isCompulsoryEA: true },
    { date: nthWeekday(2026, 7, 6, 2), name: "Penang Governor's Birthday", states: ['PNG'], isCompulsoryEA: true },
    { date: '2026-07-21', name: 'Hari Hol Almarhum Sultan Iskandar', states: ['JHR'] },
    { date: nthWeekday(2026, 10, 6, 1), name: "Sabah Governor's Birthday", states: ['SBH'], isCompulsoryEA: true },
    { date: nthWeekday(2026, 10, 6, 2), name: "Sarawak Governor's Birthday", states: ['SWK'], isCompulsoryEA: true },
    { date: nthWeekday(2026, 11, 5, 1), name: "Sultan of Perak's Birthday", states: ['PRK'], isCompulsoryEA: true },
    ...fixedStateDays(2026),
  ],

  // ── 2027: PROJECTED — fixed dates reliable; moon-sighting dates tentative ──
  2027: [
    { date: '2027-01-01', name: "New Year's Day", states: 'ALL', except: NO_NEW_YEAR },
    { date: '2027-02-06', name: 'Chinese New Year', states: 'ALL' },
    { date: '2027-02-07', name: 'Chinese New Year Day 2', states: 'ALL' },
    { date: '2027-02-24', name: 'Nuzul Al-Quran', states: 'ALL', except: NUZUL_EXCEPT, tentative: true },
    { date: '2027-03-10', name: 'Hari Raya Aidilfitri', states: 'ALL', tentative: true },
    { date: '2027-03-11', name: 'Hari Raya Aidilfitri Day 2', states: 'ALL', tentative: true },
    { date: '2027-05-01', name: 'Labour Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2027-05-20', name: 'Wesak Day', states: 'ALL', tentative: true },
    { date: '2027-06-07', name: "Yang di-Pertuan Agong's Birthday", states: 'ALL', isCompulsoryEA: true },
    { date: '2027-05-17', name: 'Hari Raya Haji', states: 'ALL', tentative: true },
    { date: '2027-06-06', name: 'Awal Muharram', states: 'ALL', tentative: true },
    { date: '2027-08-31', name: 'National Day (Merdeka)', states: 'ALL', isCompulsoryEA: true },
    { date: '2027-08-14', name: 'Maulidur Rasul', states: 'ALL', tentative: true },
    { date: '2027-09-16', name: 'Malaysia Day', states: 'ALL', isCompulsoryEA: true },
    { date: '2027-10-28', name: 'Deepavali', states: 'ALL', except: ['SWK'], tentative: true },
    { date: '2027-12-25', name: 'Christmas Day', states: 'ALL' },
    // State-only (projected)
    { date: '2027-01-06', name: 'Israk Mikraj', states: ISRAK_MIKRAJ, tentative: true },
    { date: '2027-01-21', name: 'Thaipusam', states: THAIPUSAM, tentative: true },
    { date: '2027-02-08', name: 'Awal Ramadan', states: AWAL_RAMADAN, tentative: true },
    { date: '2027-03-26', name: 'Good Friday', states: GOOD_FRIDAY },
    { date: '2027-06-13', name: "Sultan of Kedah's Birthday", states: ['KDH'], isCompulsoryEA: true, tentative: true },
    { date: nthWeekday(2027, 7, 6, 2), name: "Penang Governor's Birthday", states: ['PNG'], isCompulsoryEA: true },
    { date: '2027-07-21', name: 'Hari Hol Almarhum Sultan Iskandar', states: ['JHR'] },
    { date: nthWeekday(2027, 10, 6, 1), name: "Sabah Governor's Birthday", states: ['SBH'], isCompulsoryEA: true },
    { date: nthWeekday(2027, 10, 6, 2), name: "Sarawak Governor's Birthday", states: ['SWK'], isCompulsoryEA: true },
    { date: nthWeekday(2027, 11, 5, 1), name: "Sultan of Perak's Birthday", states: ['PRK'], isCompulsoryEA: true },
    ...fixedStateDays(2027),
  ],
};
