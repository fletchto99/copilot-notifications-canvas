import { apiTarget } from "../shared/model.mjs";

export async function loadDevelopmentAPI(preferences) {
  const target = apiTarget(await preferences.readDevelopmentAPI());
  return {
    target,
    async snapshot() {
      const savedBaseUrl = await preferences.readDevelopmentAPI();
      return { baseUrl: target.baseUrl, savedBaseUrl, requiresReload: savedBaseUrl !== target.baseUrl };
    },
    async update(input) {
      await preferences.updateDevelopmentAPI(input);
    },
  };
}
