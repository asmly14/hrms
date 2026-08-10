/**
 * Working global search — replaces the dead TopBar input whose Enter key
 * always navigated to /employees regardless of the query.
 *
 *  - Debounced (~150 ms) as-you-type dropdown.
 *  - Searches employees by name / email / NRIC / staff no., scoped to the
 *    session role via useAuth.scopeEmployees (Employee sees only their own
 *    record; Manager their department; Admin/HR/SuperAdmin the company), plus
 *    nav pages by title (role- and module-filtered via visibleNavItems).
 *  - Keyboard: ↑/↓ move highlight, Enter opens the highlighted (or first)
 *    result, Esc closes. Click/tap works too; clicking outside closes.
 *  - Employee result → /employees/:id (the detail page self-gates Employee
 *    sessions to their own record); page result → the route.
 *  - "No results" state. On phones a search icon toggles a full-width bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, UserRound, X, type LucideIcon } from 'lucide-react';
import { useAuth } from '@/lib/useAuth';
import { useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useEffectiveRole } from './useEffectiveRole';
import { visibleNavItems } from './nav';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface SearchResult {
  id: string;
  kind: 'employee' | 'page';
  icon: LucideIcon;
  title: string;
  sub: string;
  href: string;
}

const DEBOUNCE_MS = 150;
const MAX_EMPLOYEES = 5;
const MAX_PAGES = 4;

export default function GlobalSearch() {
  const navigate = useNavigate();
  const { role } = useEffectiveRole();
  const { isSuperAdmin, scopeEmployees } = useAuth();
  const { items: employees } = useCollection<Employee>('employees');

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [active, setActive] = useState(0);

  const desktopRef = useRef<HTMLDivElement>(null);
  const mobileRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Debounce the query (~150 ms). The keyboard highlight resets in the same
  // timeout callback so it always tracks the visible result set (no effect).
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(query.trim().toLowerCase());
      setActive(0);
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const results = useMemo<SearchResult[]>(() => {
    if (!debounced) return [];
    const empResults: SearchResult[] = scopeEmployees(employees)
      .filter((e) =>
        e.name.toLowerCase().includes(debounced) ||
        e.email.toLowerCase().includes(debounced) ||
        e.ic.toLowerCase().includes(debounced) ||
        (e.employeeNo ?? '').toLowerCase().includes(debounced),
      )
      .slice(0, MAX_EMPLOYEES)
      .map((e) => ({
        id: `emp-${e.id}`,
        kind: 'employee' as const,
        icon: UserRound,
        title: e.name,
        sub: [e.employeeNo, e.email].filter(Boolean).join(' · '),
        href: `/employees/${e.id}`,
      }));
    const pageResults: SearchResult[] = visibleNavItems(role, isSuperAdmin)
      .filter((i) => i.title.toLowerCase().includes(debounced))
      .slice(0, MAX_PAGES)
      .map((i) => ({
        id: `page-${i.path}`,
        kind: 'page' as const,
        icon: i.icon,
        title: i.title,
        sub: 'Go to page',
        href: i.path,
      }));
    return [...empResults, ...pageResults];
  }, [debounced, employees, scopeEmployees, role, isSuperAdmin]);

  const close = () => {
    setOpen(false);
    setMobileOpen(false);
  };

  const go = (r: SearchResult) => {
    navigate(r.href);
    setQuery('');
    close();
  };

  // Close on click/tap outside the search surfaces (desktop dropdown, mobile
  // bar, mobile toggle button).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        desktopRef.current?.contains(target) ||
        mobileRef.current?.contains(target) ||
        toggleRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      close();
      e.currentTarget.blur();
      return;
    }
    if (results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active] ?? results[0]!);
    }
  };

  const showDropdown = open && query.trim().length > 0;
  // Avoid flashing "No results" during the 150 ms debounce window.
  const settled = query.trim().toLowerCase() === debounced;

  const panel = (extraClass: string) => (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-popover shadow-lg',
        extraClass,
      )}
      role="listbox"
      aria-label="Search results"
    >
      {results.length === 0 ? (
        <p className="px-3 py-4 text-center text-sm text-muted-foreground">
          {settled ? `No results for “${query.trim()}”` : 'Searching…'}
        </p>
      ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
          {results.map((r, i) => (
            <li key={r.id} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2 text-left text-sm',
                  i === active ? 'bg-accent' : 'hover:bg-accent/60',
                )}
                // mousedown (not click) so the input keeps focus until pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <r.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{r.title}</span>
                  <span className="truncate text-xs text-muted-foreground">{r.sub}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop / tablet: inline input in the topbar. */}
      <div ref={desktopRef} className="relative ml-auto hidden w-full max-w-xs md:block">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search employees, pages…"
          className="pl-8"
          role="combobox"
          aria-expanded={showDropdown}
          aria-label="Global search"
        />
        {showDropdown && panel('absolute left-0 right-0 top-full z-50 mt-1')}
      </div>

      {/* Phones: icon toggles a full-width search bar under the topbar. */}
      <Button
        ref={toggleRef}
        variant="ghost"
        size="icon"
        className="ml-auto md:hidden"
        aria-label={mobileOpen ? 'Close search' : 'Search'}
        onClick={() => {
          setMobileOpen((v) => !v);
          setOpen(true);
        }}
      >
        <Search className="h-4 w-4" />
      </Button>
      {mobileOpen && (
        <div
          ref={mobileRef}
          className="fixed inset-x-0 top-14 z-40 border-b bg-card p-3 shadow-lg md:hidden"
        >
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search employees, pages…"
              className="pl-8 pr-9"
              role="combobox"
              aria-expanded={query.trim().length > 0}
              aria-label="Global search"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-0.5 top-0.5 h-9 w-9"
              aria-label="Close search"
              onClick={close}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          {query.trim().length > 0 && panel('mt-2 max-h-[55vh]')}
        </div>
      )}
    </>
  );
}
