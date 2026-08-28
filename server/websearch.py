"""Which search provider runs, and what happens when it fails.

The `web_search` tool calls this rather than either provider directly, so
neither tools.py nor the agent nor the Sources panel knows or cares which one
answered -- both return the same [{title, url, snippet}] shape.

Order, and why it is this way round:

  Tavily first, whenever TAVILY_API_KEY is set. The obvious arrangement is the
  other way -- free scraping first, spend the metered quota only when it fails
  -- and it is wrong here. DuckDuckGo does not fail fast from a datacenter; it
  hangs, and duckduckgo.py spends its whole 20s budget discovering that. Trying
  it first would put 20 dead seconds in front of every production search, out
  of a 60s request that still has to generate an answer afterwards.

  DuckDuckGo second, as the fallback for a bad key, an exhausted quota, or a
  Tavily outage. With no key configured at all it is the only provider, which
  is what keeps a fresh clone working with nothing to sign up for.

Quota is not the constraint that decides this: web_search is capped at one
call per turn (ONCE_PER_TURN in agent.py), so Tavily's 1,000 free searches a
month are 1,000 conversations, not 1,000 requests.
"""

from typing import Dict, List

import duckduckgo
import tavily

# Re-exported so callers catch one exception type regardless of provider.
SearchUnavailable = duckduckgo.SearchUnavailable


def provider() -> str:
    """Which provider a search would use right now -- reported in the tool
    result so an answer's sources say where they actually came from."""
    return "tavily.com" if tavily.available() else "duckduckgo.com"


def search(query: str, max_results: int = 5) -> List[Dict[str, str]]:
    """Search the web. Raises SearchUnavailable if every provider fails."""
    if tavily.available():
        try:
            results = tavily.search(query, max_results)
            if results:
                return results
            # A key that works but found nothing is a real no-match, not a
            # provider failure -- but DuckDuckGo is free to try, so fall
            # through rather than reporting an empty web.
        except tavily.TavilyUnavailable as exc:
            print(f"[search] Tavily unavailable, falling back to DuckDuckGo: {exc}")

    return duckduckgo.search(query, max_results)
