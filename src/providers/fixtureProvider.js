export async function resolveWithFixture(inputUrl, config) {
  if (!config.fixtureDownloadUrl) {
    throw new Error("FIXTURE_DOWNLOAD_URL is not configured");
  }

  return {
    provider: "fixture",
    status: "ok",
    sourceUrl: inputUrl,
    title: config.fixtureTitle,
    directUrl: config.fixtureDownloadUrl,
    diagnostics: {
      note: "Fixture mode is for UI testing only.",
    },
  };
}

