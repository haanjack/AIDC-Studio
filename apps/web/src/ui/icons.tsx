import type { SVGProps } from 'react';

type IconName =
  | 'overview' | 'site' | 'layout' | 'architecture' | 'power' | 'cooling' | 'network' | 'workload' | 'cost' | 'schedule' | 'docs' | 'catalog' | 'drawings'
  | 'check' | 'warning' | 'error' | 'info' | 'play' | 'stop' | 'download' | 'undo' | 'redo' | 'save' | 'plus' | 'trash'
  | 'camera' | 'expand' | 'collapse' | 'layers' | 'move' | 'rotate' | 'copy' | 'upload' | 'refresh' | 'cube' | 'chevron';

const PATHS: Record<IconName, string> = {
  overview: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  site: 'M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10zM12 13.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  layout: 'M3 4h18v16H3zM3 9h18M9 9v11M15 9v11',
  architecture: 'M4 5h16v5H4zM6 10v9h12v-9M8 14h3v5M13 14h3v5M7 3h10',
  power: 'M13 2 4 14h7l-1 8 9-12h-7z',
  cooling: 'M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0zM12 17.5v-6',
  network: 'M12 3v5M6 16v-3h12v3M5 16h2v4H5zM11 16h2v4h-2zM17 16h2v4h-2zM10 8h4v4h-4z',
  workload: 'M8 4H6a2 2 0 0 0-2 2v2M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2M20 16v2a2 2 0 0 1-2 2h-2M7 14l3-3 2 2 5-5',
  cost: 'M4 7h16v12H4zM4 11h16M8 15h3M16 3v4M8 3v4',
  schedule: 'M3 5h18v15H3zM3 10h18M8 3v4M16 3v4M7 14h5M10 17h6',
  docs: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  catalog: 'M4 5h16v14H4zM4 10h16M9 5v14M13 13h4M13 16h4',
  drawings: 'M3 4h18v14H3zM3 12h18M8 4v8M16 12v6M6 21h12M12 18v3',
  check: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 10',
  warning: 'M12 3 2 20h20zM12 10v4M12 17.2v.3',
  error: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v6M12 7.5v.3',
  play: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7V3M8 14h8v7H8z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  expand: 'M4 10V4h6M20 14v6h-6M14 4h6v6M10 20H4v-6',
  collapse: 'M10 4v6H4M14 20v-6h6M20 10h-6V4M4 14h6v6',
  layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
  move: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3',
  rotate: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  copy: 'M8 8h12v12H8zM4 16V4h12',
  refresh: 'M20 11a8 8 0 0 0-14.9-3M4 4v5h5M4 13a8 8 0 0 0 14.9 3M20 20v-5h-5',
  cube: 'M12 3 3 7.5v9L12 21l9-4.5v-9zM3 7.5 12 12l9-4.5M12 12v9',
  chevron: 'M9 6l6 6-6 6',
};

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}

export type { IconName };
