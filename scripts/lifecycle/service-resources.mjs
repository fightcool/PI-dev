/* 🍞 AI Breadcrumb: @COUPLED scripts/service.mjs, deploy/pi-web-ui-dev.service.in
 * @CONTRACT Install-time overrides only; keep headroom between V8 heap and cgroup limits.
 * @WHY Defaults suit smaller hosts. On an 8 GiB host, opt in to 2048 / 3G / 4G.
 */
function memoryBytes(value, field) {
  const match = typeof value === "string" && /^([1-9][0-9]*)(M|G)$/.exec(value);
  const bytes = match && Number(match[1]) * (match[2] === "G" ? 1024 ** 3 : 1024 ** 2);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(`${field} must be a positive integer followed by M or G.`);
  return bytes;
}

export function serviceResources(env = process.env) {
  const heap = env.PI_DEV_HEAP_MB ?? "1024";
  if (typeof heap !== "string" || !/^[1-9][0-9]*$/.test(heap) || !Number.isSafeInteger(Number(heap) * 1024 ** 2))
    throw new Error("PI_DEV_HEAP_MB must be a positive integer in MiB.");
  const high = env.PI_DEV_MEMORY_HIGH ?? "1536M";
  const max = env.PI_DEV_MEMORY_MAX ?? "2G";
  const highBytes = memoryBytes(high, "PI_DEV_MEMORY_HIGH");
  const maxBytes = memoryBytes(max, "PI_DEV_MEMORY_MAX");
  if (Number(heap) * 1024 ** 2 >= highBytes || highBytes > maxBytes)
    throw new Error("Resource limits must satisfy heap < MemoryHigh <= MemoryMax.");
  return { HEAP_MB: heap, MEMORY_HIGH: high, MEMORY_MAX: max };
}
