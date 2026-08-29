import { FolderOpen, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { HostPlatform } from '@/lib/host';

export interface HelperArgvValidation {
  program?: string;
  args: Array<string | undefined>;
}

export function validateHelperArgv(program: string, args: string[], platform: HostPlatform): HelperArgvValidation {
  const value = program.trim();
  const hasHelper = value.length > 0 || args.length > 0;
  let programError: string | undefined;

  if (hasHelper && !value) {
    programError = 'Choose the helper program.';
  } else if (value) {
    const absolute =
      platform === 'windows' ? /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) : value.startsWith('/');
    if (!absolute) {
      programError =
        platform === 'windows'
          ? 'Use an absolute Windows path, such as C:\\Tools\\helper.exe.'
          : 'Use an absolute path beginning with /.';
    } else if (platform === 'windows' && !/\.(?:exe|com)$/i.test(value)) {
      programError = 'Windows helper programs must end in .exe or .com.';
    }
  }

  return {
    program: programError,
    args: args.map((arg) => (arg.trim() ? undefined : 'Argument cannot be empty.')),
  };
}

/**
 * Split a legacy helper using the conversion rule shown in the UI: whitespace
 * separates argv entries, while matching single or double quotes group text.
 * Backslashes always stay literal so Windows paths cannot be corrupted. This
 * is a draft conversion only; the user must confirm it.
 */
export function splitLegacyHelper(command: string): string[] {
  const argv: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        tokenStarted = true;
      } else {
        token += char;
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        argv.push(token);
        token = '';
        tokenStarted = false;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
    } else {
      token += char;
      tokenStarted = true;
    }
  }

  if (quote) throw new Error(`The legacy helper has an unmatched ${quote} quote.`);
  if (tokenStarted) argv.push(token);
  return argv;
}

export function CredentialHelperEditor({
  program,
  args,
  platform,
  showErrors,
  onProgramChange,
  onArgsChange,
  onPickProgram,
}: {
  program: string;
  args: string[];
  platform: HostPlatform;
  showErrors: boolean;
  onProgramChange: (program: string) => void;
  onArgsChange: (args: string[]) => void;
  onPickProgram?: () => Promise<string | null>;
}) {
  const validation = validateHelperArgv(program, args, platform);
  const focusArg = (index: number) =>
    window.requestAnimationFrame(() => document.getElementById(`credential-helper-arg-${index}`)?.focus());
  const addArg = (after = args.length - 1) => {
    const index = Math.max(0, after + 1);
    const next = [...args];
    next.splice(index, 0, '');
    onArgsChange(next);
    focusArg(index);
  };
  const removeArg = (index: number) => {
    onArgsChange(args.filter((_, candidate) => candidate !== index));
    if (args.length > 1) focusArg(Math.max(0, index - 1));
    else window.requestAnimationFrame(() => document.getElementById('credential-helper-add-arg')?.focus());
  };

  return (
    <div className="space-y-3">
      <Field
        label="Helper program"
        htmlFor="credential-helper-program"
        hint="Optional. Use an absolute executable path; its standard output becomes the credential."
        error={
          showErrors && validation.program ? (
            <span id="credential-helper-program-error">{validation.program}</span>
          ) : undefined
        }
      >
        <div className="flex gap-2">
          <Input
            id="credential-helper-program"
            mono
            value={program}
            onChange={(event) => onProgramChange(event.target.value)}
            aria-invalid={showErrors && Boolean(validation.program)}
            aria-describedby={showErrors && validation.program ? 'credential-helper-program-error' : undefined}
          />
          {onPickProgram ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onPickProgram().then((picked) => picked && onProgramChange(picked))}
            >
              <FolderOpen className="h-3.5 w-3.5" aria-hidden />
              Browse
            </Button>
          ) : null}
        </div>
      </Field>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-xs font-medium leading-4">Arguments</span>
          <Button id="credential-helper-add-arg" type="button" size="sm" variant="ghost" onClick={() => addArg()}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add argument
          </Button>
        </div>
        {args.length ? (
          <div className="space-y-2">
            {args.map((arg, index) => {
              const errorId = `credential-helper-arg-${index}-error`;
              return (
                <div key={index}>
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="w-8 shrink-0 text-xs">
                      {index + 1}
                    </span>
                    <Input
                      id={`credential-helper-arg-${index}`}
                      aria-label={`Helper argument ${index + 1}`}
                      mono
                      value={arg}
                      onChange={(event) =>
                        onArgsChange(args.map((value, candidate) => (candidate === index ? event.target.value : value)))
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addArg(index);
                        } else if (event.key === 'Backspace' && !arg) {
                          event.preventDefault();
                          removeArg(index);
                        }
                      }}
                      aria-invalid={showErrors && Boolean(validation.args[index])}
                      aria-describedby={showErrors && validation.args[index] ? errorId : undefined}
                    />
                    <button
                      type="button"
                      aria-label={`Remove helper argument ${index + 1}`}
                      onClick={() => removeArg(index)}
                      className="shrink-0 rounded p-1 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  {showErrors && validation.args[index] ? (
                    <p
                      id={errorId}
                      role="alert"
                      className="ml-10 mt-1 text-xs leading-4 text-[var(--color-destructive-foreground)]"
                    >
                      {validation.args[index]}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-muted-foreground)]">No arguments.</p>
        )}
      </div>
    </div>
  );
}
