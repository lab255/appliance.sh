'use client';

import * as React from 'react';
import { Input } from './input.js';
import { Popover, PopoverAnchor, PopoverContent } from './popover.js';
import { cn } from '../lib/utils.js';

export interface ComboboxOption {
  value: string;
  label: string;
  keywords?: string;
  description?: string;
}

export interface ComboboxProps {
  options: readonly ComboboxOption[];
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (option: ComboboxOption) => void;
  label: string;
  placeholder?: string;
  inputClassName?: string;
  disabled?: boolean;
}

/** Editable listbox: DOM focus stays in the input; selection never submits a form. */
export function Combobox({
  options,
  query,
  onQueryChange,
  onSelect,
  label,
  placeholder,
  inputClassName,
  disabled,
}: ComboboxProps) {
  const id = React.useId();
  const input = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  const [activeValue, setActiveValue] = React.useState<string | null>(null);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = options.filter((option) =>
    `${option.label}\n${option.keywords ?? ''}`.toLocaleLowerCase().includes(needle)
  );
  const activeIndex = filtered.findIndex((option) => option.value === activeValue);
  const expanded = open && !disabled;
  const activeId = expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined;

  React.useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const select = (option: ComboboxOption) => {
    onQueryChange(option.label);
    onSelect(option);
    setOpen(false);
    setActiveValue(null);
  };

  return (
    <Popover open={expanded} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Input
          ref={input}
          role="combobox"
          aria-label={label}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={expanded}
          aria-controls={expanded ? `${id}-listbox` : undefined}
          aria-activedescendant={activeId}
          autoComplete="off"
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          className={inputClassName}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActiveValue(null);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              const next =
                !expanded || activeIndex < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : filtered.length - 1
                  : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length;
              setActiveValue(filtered[next]?.value ?? null);
            } else if (event.key === 'Enter' && expanded && activeIndex >= 0) {
              event.preventDefault();
              select(filtered[activeIndex]);
            } else if (event.key === 'Escape' && expanded) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              setActiveValue(null);
            } else if (event.key === 'Tab') {
              setOpen(false);
              setActiveValue(null);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        role="presentation"
        aria-hidden={!expanded}
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-1"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target === input.current) event.preventDefault();
        }}
      >
        <ul id={`${id}-listbox`} role="listbox" aria-label={label} className="max-h-64 overflow-auto">
          {filtered.map((option, index) => (
            <li
              key={option.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                'cursor-default rounded-sm px-3 py-2 text-sm text-[var(--color-foreground)] hover:bg-[var(--color-hover)]',
                index === activeIndex && 'bg-[var(--color-hover)]'
              )}
              onPointerMove={() => setActiveValue(option.value)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(option)}
            >
              <span className="block font-medium">{option.label}</span>
              {option.description && (
                <span className="block text-xs text-[var(--color-muted-foreground)]">{option.description}</span>
              )}
            </li>
          ))}
        </ul>
        {filtered.length === 0 && (
          <p role="status" className="px-3 py-2 text-sm text-[var(--color-muted-foreground)]">
            No matches
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
