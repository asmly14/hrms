/**
 * BulkActionBar — sticky selection bar for the employee directory.
 * Desktop: inline bar above the table. Small screens: collapses to a fixed
 * bottom sheet. All actions route through the shared SeparationMenu dialogs.
 */
import { X } from 'lucide-react';
import type { Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { SeparationMenu } from './SeparationActions';

interface BulkActionBarProps {
  selected: Employee[];
  actorName: string;
  onClear: () => void;
}

export function BulkActionBar({ selected, actorName, onClear }: BulkActionBarProps) {
  if (selected.length === 0) return null;

  const actions = (
    <>
      <SeparationMenu
        targets={selected}
        actorName={actorName}
        onCompleted={onClear}
        align="start"
        trigger={
          <Button size="sm" className="bg-amber-600 text-white hover:bg-amber-700">
            Separation actions
          </Button>
        }
      />
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X className="mr-1 h-4 w-4" /> Clear selection
      </Button>
    </>
  );

  return (
    <>
      {/* Desktop / tablet — inline sticky bar */}
      <div className="sticky top-2 z-20 hidden items-center gap-3 rounded-xl border border-amber-200/70 bg-amber-50/90 px-4 py-2.5 shadow-sm backdrop-blur md:flex">
        <p className="text-sm font-medium">
          <span className="font-semibold text-amber-800">{selected.length}</span> selected
        </p>
        <div className="ml-auto flex items-center gap-2">{actions}</div>
      </div>

      {/* Mobile — fixed bottom sheet */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-amber-200/70 bg-amber-50/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur md:hidden">
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium">
            <span className="font-semibold text-amber-800">{selected.length}</span> selected
          </p>
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
      </div>
    </>
  );
}
