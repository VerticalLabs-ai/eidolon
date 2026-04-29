import { afterEach, describe, expect, it } from 'vitest';
import {
  getAdminEmails,
  getAuthorizedEmails,
  isAuthorizedEmail,
  resolveUserRole,
} from '../auth.js';

const ORIGINAL_AUTHORIZED_EMAILS = process.env.EIDOLON_AUTHORIZED_EMAILS;
const ORIGINAL_ADMIN_EMAILS = process.env.EIDOLON_ADMIN_EMAILS;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('auth policy', () => {
  afterEach(() => {
    restoreEnv('EIDOLON_AUTHORIZED_EMAILS', ORIGINAL_AUTHORIZED_EMAILS);
    restoreEnv('EIDOLON_ADMIN_EMAILS', ORIGINAL_ADMIN_EMAILS);
  });

  it('defaults to only matt@verticallabs.ai as an authorized admin', () => {
    delete process.env.EIDOLON_AUTHORIZED_EMAILS;
    delete process.env.EIDOLON_ADMIN_EMAILS;

    expect([...getAuthorizedEmails()]).toEqual(['matt@verticallabs.ai']);
    expect([...getAdminEmails()]).toEqual(['matt@verticallabs.ai']);
    expect(isAuthorizedEmail('Matt@VerticalLabs.ai')).toBe(true);
    expect(isAuthorizedEmail('other@example.com')).toBe(false);
    expect(resolveUserRole({ email: 'matt@verticallabs.ai' })).toBe('admin');
  });

  it('honors explicit authorized and admin email lists', () => {
    process.env.EIDOLON_AUTHORIZED_EMAILS = 'matt@verticallabs.ai';
    process.env.EIDOLON_ADMIN_EMAILS = 'ada@example.com';

    expect(isAuthorizedEmail('matt@verticallabs.ai')).toBe(true);
    expect(isAuthorizedEmail('ada@example.com')).toBe(true);
    expect(resolveUserRole({ email: 'ada@example.com', metadataRole: 'member' })).toBe(
      'admin',
    );
    expect(resolveUserRole({ email: 'matt@verticallabs.ai', metadataRole: 'member' })).toBe(
      'member',
    );
  });
});
