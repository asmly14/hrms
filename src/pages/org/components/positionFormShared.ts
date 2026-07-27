/**
 * Shared position-form contract (values + mappers) — kept component-free so
 * react-refresh stays happy in PositionForm.tsx and every consumer imports
 * the same shape.
 */
import { gradeForLevel, type PositionProfile } from '@/lib/orgChart';
import type { Position, PositionLevel } from '@/lib/types';

export interface PositionFormValues {
  title: string;
  departmentId: string;
  level: PositionLevel;
  minSalary: number;
  maxSalary: number;
  grade: string;
  /** null = root of the chart. */
  reportsToPositionId: string | null;
  dottedLineReportsToPositionId: string | null;
  jobDescription: string;
  responsibilities: string[];
  qualifications: string[];
  headcountBudget?: number;
}

export const EMPTY_POSITION_FORM: PositionFormValues = {
  title: '',
  departmentId: '',
  level: 'junior',
  minSalary: 0,
  maxSalary: 0,
  grade: 'L2',
  reportsToPositionId: null,
  dottedLineReportsToPositionId: null,
  jobDescription: '',
  responsibilities: [],
  qualifications: [],
  headcountBudget: undefined,
};

export function valuesFromPosition(position: Position, profile?: PositionProfile): PositionFormValues {
  return {
    title: position.title,
    departmentId: position.departmentId,
    level: position.level,
    minSalary: position.minSalary,
    maxSalary: position.maxSalary,
    grade: profile?.grade || gradeForLevel(position.level),
    reportsToPositionId: profile?.reportsToPositionId ?? null,
    dottedLineReportsToPositionId: profile?.dottedLineReportsToPositionId ?? null,
    jobDescription: profile?.jobDescription ?? '',
    responsibilities: profile?.responsibilities ?? [],
    qualifications: profile?.qualifications ?? [],
    headcountBudget: profile?.headcountBudget,
  };
}
