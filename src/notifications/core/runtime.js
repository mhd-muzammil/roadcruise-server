/**
 * Holds the initialized engine singletons (repository, queue, service) so the
 * admin API controller can reach them without circular imports. Set once during
 * module init.
 */
let runtime = null;
export const setRuntime = (r) => (runtime = r);
export const getRuntime = () => {
  if (!runtime) throw new Error("Notification engine not initialized — call notifications.init() first");
  return runtime;
};
export default getRuntime;
