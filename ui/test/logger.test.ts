import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, type Logger } from '../src/lib/logger';

describe('structured logger', () => {
  const mockConsole = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    mockConsole.log.mockClear();
    mockConsole.error.mockClear();
    mockConsole.warn.mockClear();
    mockConsole.info.mockClear();
    mockConsole.debug.mockClear();
    vi.stubGlobal('console', mockConsole);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('production output', () => {
    it('emits JSON for info level with message and context', () => {
      const logger = createLogger({ isProduction: true });
      logger.info('company created', { companyId: 'c1' });

      expect(mockConsole.log).toHaveBeenCalledTimes(1);
      const entry = JSON.parse(mockConsole.log.mock.calls[0][0] as string);
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('company created');
      expect(entry.companyId).toBe('c1');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('emits JSON for all supported levels', () => {
      const logger = createLogger({ isProduction: true });
      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');

      const levels = mockConsole.log.mock.calls.map((call) => JSON.parse(call[0] as string).level);
      expect(levels).toEqual(['error', 'warn', 'info', 'debug']);
    });

    it('includes empty context when none is provided', () => {
      const logger = createLogger({ isProduction: true });
      logger.warn('no context');
      const entry = JSON.parse(mockConsole.log.mock.calls[0][0] as string);
      expect(entry.message).toBe('no context');
      expect(Object.prototype.hasOwnProperty.call(entry, 'timestamp')).toBe(true);
    });
  });

  describe('development output', () => {
    it('pretty-prints error level to console.error', () => {
      const logger = createLogger({ isProduction: false });
      logger.error('import failed', { error: 'network' });

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      const line = mockConsole.error.mock.calls[0][0] as string;
      expect(line).toContain('[ERROR]');
      expect(line).toContain('import failed');
      expect(line).toContain('network');
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('pretty-prints all levels to the matching console method', () => {
      const logger = createLogger({ isProduction: false });
      logger.error('e');
      logger.warn('w');
      logger.info('i');
      logger.debug('d');

      expect(mockConsole.error).toHaveBeenCalledTimes(1);
      expect(mockConsole.warn).toHaveBeenCalledTimes(1);
      expect(mockConsole.info).toHaveBeenCalledTimes(1);
      expect(mockConsole.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe('default logger', () => {
    it('exports a ready-to-use logger', async () => {
      // The module exports a singleton logger bound to the runtime environment.
      // Importing the module should not throw and should yield a Logger instance.
      const mod = await import('../src/lib/logger');
      const defaultLogger: Logger = mod.logger;
      expect(defaultLogger).toBeDefined();
      expect(typeof defaultLogger.info).toBe('function');
      expect(typeof defaultLogger.error).toBe('function');
      expect(typeof defaultLogger.warn).toBe('function');
      expect(typeof defaultLogger.debug).toBe('function');
    });
  });
});
