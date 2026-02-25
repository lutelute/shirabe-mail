interface LoadingSkeletonProps {
  rows?: number;
  variant?: 'list' | 'card' | 'detail';
}

export default function LoadingSkeleton({ rows = 5, variant = 'list' }: LoadingSkeletonProps) {
  if (variant === 'card') {
    return (
      <div className="p-4 space-y-3 animate-pulse">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="p-3 bg-surface-800 rounded space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-4 bg-surface-700 rounded w-4" />
              <div className="h-4 bg-surface-700 rounded w-3/4" />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 bg-surface-700 rounded w-16" />
              <div className="h-3 bg-surface-700 rounded w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'detail') {
    return (
      <div className="p-4 space-y-4 animate-pulse">
        <div className="h-6 bg-surface-700 rounded w-1/3" />
        <div className="space-y-2">
          <div className="h-4 bg-surface-700 rounded w-full" />
          <div className="h-4 bg-surface-700 rounded w-5/6" />
          <div className="h-4 bg-surface-700 rounded w-3/4" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3 animate-pulse">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="h-4 bg-surface-700 rounded w-3/4" />
            <div className="h-4 bg-surface-700 rounded w-16" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 bg-surface-700 rounded w-1/3" />
            <div className="h-3 bg-surface-700 rounded w-20" />
          </div>
          <div className="h-3 bg-surface-700 rounded w-full" />
        </div>
      ))}
    </div>
  );
}
