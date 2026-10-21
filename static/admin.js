(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activate() {
    const race = location.hash === '#race' || location.hash === '#race-setup';
    tabs.forEach((tab, index) => {
      const active = index === (race ? 1 : 0);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => { location.hash = index ? 'race' : 'monitoring'; });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      tabs[next].focus(); tabs[next].click();
    });
  });
  addEventListener('hashchange', activate);
  activate();
})();
