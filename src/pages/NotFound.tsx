import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <p className="text-6xl font-bold tracking-tight text-amber-600">404</p>
      <p className="text-lg font-medium">This page isn't on the map.</p>
      <p className="max-w-md text-sm text-muted-foreground">
        The route may belong to a module that hasn't been wired in yet, or the link is stale.
      </p>
      <Button asChild className="rounded-xl">
        <Link to="/">Back to Dashboard</Link>
      </Button>
    </div>
  );
}
