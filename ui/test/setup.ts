import { expect, beforeEach } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// Clear sessionStorage between tests so draft persistence (VAL-RUN-112)
// does not leak across test cases and cause false failures from doubled text.
beforeEach(() => {
  sessionStorage.clear();
});
