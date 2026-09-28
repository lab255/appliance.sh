import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Tailwind Merge predates this app's Tailwind v4 `--text-micro` theme
// token. Teach it that text-micro is a font size so semantic text-color
// utilities do not accidentally remove the dense type role.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
