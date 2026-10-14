/** The single Lab app owns /arcade/lab and /arcade/lab/*. */
export const labPath = "/arcade/lab/"

/** Where an old per-game `/arcade/<game>/lab.html?…` link lands: the Lab with that game chosen, other params kept. */
export function labLocation(search: string, game: string): string {
  const params = new URLSearchParams([["game", game]])
  for (const [key, value] of new URLSearchParams(search)) if (key !== "game") params.append(key, value)
  return `${labPath}?${params}`
}

/** Absolute redirect target for a game Worker. */
export function labUrl(requestUrl: string, game: string): string {
  const url = new URL(requestUrl)
  return new URL(labLocation(url.search, game), url.origin).href
}
