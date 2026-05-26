import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsoleLogger } from '../ConsoleLogger';
import { LogLevel } from '../../interfaces/ILogger';

describe('ConsoleLogger', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a logger instance', () => {
      const logger = new ConsoleLogger();
      expect(logger).toBeDefined();
      expect(logger).toBeInstanceOf(ConsoleLogger);
    });
  });

  describe('debug()', () => {
    it('should log at debug level when level is DEBUG', () => {
      const logger = new ConsoleLogger(LogLevel.DEBUG);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      logger.debug('test debug message');

      expect(spy).toHaveBeenCalledWith('[DEBUG]', 'test debug message', undefined);
    });
  });

  describe('info()', () => {
    it('should log at info level', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.info('test info message');

      expect(spy).toHaveBeenCalledWith('[INFO]', 'test info message', undefined);
    });
  });

  describe('warn()', () => {
    it('should log at warn level', () => {
      const logger = new ConsoleLogger(LogLevel.WARN);
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      logger.warn('test warn message');

      expect(spy).toHaveBeenCalledWith('[WARN]', 'test warn message', undefined);
    });
  });

  describe('error()', () => {
    it('should log at error level', () => {
      const logger = new ConsoleLogger(LogLevel.ERROR);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('test error message');

      expect(spy).toHaveBeenCalledWith('[ERROR]', 'test error message', undefined, undefined);
    });
  });

  describe('child()', () => {
    it('should return a new logger with prefix', () => {
      const logger = new ConsoleLogger(LogLevel.DEBUG);

      const childLogger = logger.child({ module: 'test-module' });

      // FAILS: child() currently returns `this` instead of a new logger with context
      expect(childLogger).not.toBe(logger);
    });

    it('should prefix messages from child logger', () => {
      const logger = new ConsoleLogger(LogLevel.DEBUG);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      const childLogger = logger.child({ module: 'worker-1' });
      childLogger.debug('child message');

      // FAILS: child() returns `this`, so no prefix is applied
      const callArgs = spy.mock.calls[0];
      expect(JSON.stringify(callArgs)).toContain('worker-1');
    });
  });

  describe('log level filtering', () => {
    it('should not show debug messages when level is INFO', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      logger.debug('should not appear');

      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('non-string arguments', () => {
    it('should handle objects passed as meta', () => {
      const logger = new ConsoleLogger(LogLevel.INFO);
      const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const meta = { count: 42, nested: { deep: true } };
      logger.info('with meta', meta);

      expect(spy).toHaveBeenCalledWith('[INFO]', 'with meta', meta);
    });

    it('should handle Error objects passed to error()', () => {
      const logger = new ConsoleLogger(LogLevel.ERROR);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const err = new Error('something broke');
      logger.error('failure', err);

      expect(spy).toHaveBeenCalledWith('[ERROR]', 'failure', err, undefined);
    });
  });

  describe('safety', () => {
    it('should not throw on any input', () => {
      const logger = new ConsoleLogger(LogLevel.DEBUG);
      vi.spyOn(console, 'debug').mockImplementation(() => {});
      vi.spyOn(console, 'info').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => logger.debug('')).not.toThrow();
      expect(() => logger.info('')).not.toThrow();
      expect(() => logger.warn('')).not.toThrow();
      expect(() => logger.error('')).not.toThrow();
      expect(() => logger.debug('msg', { key: undefined })).not.toThrow();
      expect(() => logger.error('msg', undefined, undefined)).not.toThrow();
    });
  });
});
