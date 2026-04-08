const PREFIX = '[nectar]';

module.exports = {
  info: (...args) => console.log(PREFIX, ...args),
  warn: (...args) => console.warn(PREFIX, '⚠', ...args),
  error: (...args) => console.error(PREFIX, '✗', ...args),
};
