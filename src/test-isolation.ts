import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MESSAGE = 'Unsafe test storage: set REBALANCE_DATA_DIR and any REBALANCE_ROOT_DIR to explicit absolute temporary directories before importing the app, or use npm test.';
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

// A fixture may use a not-yet-created child. Resolve its existing ancestry so a
// temporary-looking symlink cannot redirect the fixture into application data.
function canonicalPath(path: string): string {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(canonicalPath(dirname(path)), basename(path));
  }
  // An existing but dangling symlink must fail closed, not become a fictional
  // missing child under the temporary ancestor.
  return realpathSync(path);
}

/** Read-only assertion, independent of configuration and all app storage. */
export function assertTemporaryTestDirectory(path: string | undefined): asserts path is string {
  if (!path || !isAbsolute(path)) throw new Error(MESSAGE);
  try {
    // TMPDIR is inherited input, not evidence that an ordinary path is temporary.
    const roots = ['/tmp', '/private/tmp', '/var/tmp'].flatMap(root => {
      try { return [realpathSync(root)]; } catch { return []; }
    });
    let nativeRoot = '';
    try { nativeRoot = realpathSync(tmpdir()); } catch {}
    if (/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(nativeRoot) ||
        (process.platform === 'win32' && /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp$/i.test(nativeRoot))) roots.push(nativeRoot, resolve(tmpdir()));
    const resolved = resolve(path);
    // Reject ordinary/live paths before even looking up their filesystem metadata.
    if (!['/var/tmp', '/private/tmp', '/tmp', ...roots].some(root => inside(resolve(root), resolved))) throw new Error(MESSAGE);
    if (!roots.some(root => inside(root, canonicalPath(resolved)))) throw new Error(MESSAGE);
  } catch { throw new Error(MESSAGE); }
}

export function assertTestStorageEnvironment(): void {
  if (!process.env.NODE_TEST_CONTEXT) return;
  assertTemporaryTestDirectory(process.env.REBALANCE_DATA_DIR);
  if (process.env.REBALANCE_ROOT_DIR !== undefined) assertTemporaryTestDirectory(process.env.REBALANCE_ROOT_DIR);
}
