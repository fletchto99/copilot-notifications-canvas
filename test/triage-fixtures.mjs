export async function syntheticTriage({ tools, signal }) {
  const recommendations = [];
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const response = await tools[0].handler({ offset });
    if (response.resultType !== "success") throw new Error(response.textResultForLlm);
    const page = JSON.parse(response.textResultForLlm);
    recommendations.push(...page.items.map(item => ({
      ref: item.ref, category: "attention", reason: "Synthetic suggestion: <img src=x onerror=alert(1)>",
    })));
    offset = page.nextOffset;
  } while (offset !== null);
  return { recommendations };
}
