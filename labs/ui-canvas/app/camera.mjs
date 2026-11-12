// Pan and zoom. The world is one transformed element, so moving the camera touches no frame.
const MIN = 0.04, MAX = 3, FLIGHT_MS = 320;

export function createCamera({ stage, world, onChange }) {
  const camera = { x: 0, y: 0, z: 1 };
  let flight = 0, settle = 0;

  function apply() {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.z})`;
    world.style.setProperty('--z', String(camera.z));
    // Dots thin out as you zoom away, so the field never turns into noise.
    let step = 24 * camera.z;
    while (step < 14) step *= 2;
    stage.style.setProperty('--dot', `${step}px`);
    stage.style.setProperty('--dot-x', `${camera.x % step}px`);
    stage.style.setProperty('--dot-y', `${camera.y % step}px`);
    // Promote the world only while it moves: a promoted layer stays blurry at rest.
    world.classList.add('is-moving');
    clearTimeout(settle);
    settle = setTimeout(() => world.classList.remove('is-moving'), 140);
    onChange(camera);
  }

  const toWorld = (x, y) => ({ x: (x - camera.x) / camera.z, y: (y - camera.y) / camera.z });
  const toScreen = (x, y) => ({ x: x * camera.z + camera.x, y: y * camera.z + camera.y });

  function set(next) { cancelAnimationFrame(flight); Object.assign(camera, next); apply(); }
  function zoomAt(factor, x, y) {
    const z = Math.min(MAX, Math.max(MIN, camera.z * factor));
    const point = toWorld(x, y);
    set({ z, x: x - point.x * z, y: y - point.y * z });
  }
  function fly(target) {
    cancelAnimationFrame(flight);
    const from = { ...camera }, started = performance.now();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { set(target); return; }
    const step = (now) => {
      const t = Math.min(1, (now - started) / FLIGHT_MS), e = 1 - (1 - t) ** 3;
      camera.x = from.x + (target.x - from.x) * e;
      camera.y = from.y + (target.y - from.y) * e;
      camera.z = from.z + (target.z - from.z) * e;
      apply();
      if (t < 1) flight = requestAnimationFrame(step);
    };
    flight = requestAnimationFrame(step);
  }
  function fit(box, { top = 96, bottom = 180, side = 72, maxZoom = 1 } = {}) {
    if (!box) return;
    const width = innerWidth - side * 2, height = innerHeight - top - bottom;
    const z = Math.max(MIN, Math.min(maxZoom, width / box.width, height / box.height));
    fly({ z, x: side + (width - box.width * z) / 2 - box.left * z, y: top + (height - box.height * z) / 2 - box.top * z });
  }
  return { state: camera, set, zoomAt, fly, fit, toWorld, toScreen, apply };
}
