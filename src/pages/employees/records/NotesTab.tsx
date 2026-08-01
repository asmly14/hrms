/**
 * Notes log tab — free-text HR remarks in reverse-chronological order.
 */
import { useState } from 'react';
import { Send, StickyNote } from 'lucide-react';
import { addNote, removeNote, todayISO } from '@/lib/employeeRecords';
import { fmtDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyBlock, RemoveButton, SectionCard, type TabProps } from './shared';

export default function NotesTab({ employee, file, readOnly, actorName }: TabProps) {
  const [text, setText] = useState('');

  const notes = [...(file?.notes ?? [])].sort((a, b) => b.date.localeCompare(a.date));

  const submit = () => {
    if (!text.trim()) return;
    addNote(employee.id, { date: todayISO(), author: actorName, text: text.trim() }, actorName);
    setText('');
  };

  if (notes.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={StickyNote}
        title="No notes yet"
        description="HR remarks about this employee will appear here."
      />
    );
  }

  return (
    <SectionCard
      title="Notes log"
      icon={StickyNote}
      description="Chronological HR remarks — newest first."
    >
      {!readOnly && (
        <div className="mb-4 flex items-start gap-2">
          <Textarea
            rows={2}
            placeholder="Add a note to the personnel file…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            className="bg-amber-600 text-white hover:bg-amber-700"
            disabled={!text.trim()}
            onClick={submit}
          >
            <Send className="mr-1.5 h-4 w-4" /> Add
          </Button>
        </div>
      )}
      {notes.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {notes.map((n) => (
            <li key={n.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="whitespace-pre-wrap text-sm">{n.text}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {n.author} · {fmtDate(n.date)}
                </p>
              </div>
              {!readOnly && (
                <RemoveButton label="note" onConfirm={() => removeNote(employee.id, n.id, actorName)} />
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
