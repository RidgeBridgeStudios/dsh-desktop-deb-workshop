// Client module for dsh-desktop-market-installer
// Loaded into DeepSeek Harness renderer via dsh.client manifest

export const name = 'dsh-desktop-market-installer/client';
export const inject = ['slots', 'locale'];

export function apply(ctx) {
  if (ctx && ctx.slots && typeof ctx.slots.register === 'function') {
    ctx.slots.register('settings.section', {
      id: 'market-installer-section',
      order: 100
    });
    ctx.slots.register('settings.plugins.tab', {
      id: 'market-installer-tab',
      order: 100
    });
  }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'dsh-desktop-market-installer/client',
    factory: (require, exports, module) => {
      module.exports = {
        name,
        inject,
        apply
      };
    }
  });
}
