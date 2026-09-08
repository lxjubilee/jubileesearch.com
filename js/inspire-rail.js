/**
 * JubileeInspire rail — open/close behaviour.
 *
 * Desktop (>1024px): the NAVIGATION row and the collapse arrow toggle the
 * rail between 52px (icons) and 280px (icons + labels). The choice is
 * remembered per browser in localStorage.
 *
 * Mobile (<=1024px): the rail is an off-canvas drawer. The fixed hamburger
 * opens it, the backdrop / Escape / the NAVIGATION row close it.
 */
(function () {
  var rail = document.querySelector('.jir-rail');
  if (!rail) return;

  var head = rail.querySelector('.jir-item.is-head');
  var collapse = rail.querySelector('.jir-collapse');
  var burger = document.querySelector('.jir-burger');
  var backdrop = document.querySelector('.jir-backdrop');
  var mobile = window.matchMedia('(max-width: 1024px)');
  var KEY = 'jir-open';

  function read() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function write(open) {
    try { localStorage.setItem(KEY, open ? '1' : '0'); } catch (e) { /* private mode etc. */ }
  }

  function set(open) {
    rail.classList.toggle('is-open', open);
    if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (backdrop) backdrop.hidden = !(open && mobile.matches);
    if (burger) burger.classList.toggle('is-hidden', open && mobile.matches);
    if (!mobile.matches) write(open);
  }
  function toggle() { set(!rail.classList.contains('is-open')); }

  if (head) head.addEventListener('click', toggle);
  if (collapse) collapse.addEventListener('click', function () { set(false); });
  if (burger) burger.addEventListener('click', function () { set(true); });
  if (backdrop) backdrop.addEventListener('click', function () { set(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && rail.classList.contains('is-open')) set(false);
  });

  // A drawer never starts open; on desktop, restore the remembered state.
  function init() { set(mobile.matches ? false : read()); }
  if (mobile.addEventListener) mobile.addEventListener('change', init);
  else if (mobile.addListener) mobile.addListener(init);
  init();
})();
