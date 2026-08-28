"""Tavily search client.

A keyed alternative to the scraped DuckDuckGo endpoints in duckduckgo.py,
used because those do not work from a datacenter: DuckDuckGo answers a
residential IP in under a second and leaves a hosted one hanging until the
request budget runs out. See websearch.py for which one runs when.

Only the REST endpoint is used -- no `tavily-python` package. One httpx POST
is the whole integration, httpx already ships with the OpenAI SDK, and a
dependency whose entire job is to build one JSON body is not worth the
install on a small Render instance.
"""

import os
from typing import Any, Dict, List, Optional

# pyrefly: ignore [missing-import]
import httpx

ENDPOINT = "https://api.tavily.com/search"

# Well inside the caller's budget -- see duckduckgo.TOTAL_BUDGET_SECONDS for
# why the whole search has to fit in one, and what happens when it does not.
TIMEOUT_SECONDS = 10.0


def api_key() -> str:
    """Read at call time, not import time, so a key added to the environment
    after this module was first imported is still picked up."""
    return os.environ.get("TAVILY_API_KEY", "").strip()


def available() -> bool:
    return bool(api_key())


class TavilyUnavailable(RuntimeError):
    """Tavily refused or could not be reached (bad key, quota, network)."""


def search(query: str, max_results: int = 5, timeout: Optional[float] = None) -> List[Dict[str, str]]:
    """Return [{title, url, snippet}] -- the same shape duckduckgo.search does.

    Mapping the response here rather than at the call site is what lets
    websearch.py treat the two providers as interchangeable, and what keeps
    tools.py, the agent and the Sources panel from knowing which one ran.
    """
    key = api_key()
    if not key:
        raise TavilyUnavailable("TAVILY_API_KEY is not set.")

    try:
        response = httpx.post(
            ENDPOINT,
            json={
                "query": query,
                "max_results": max_results,
                # Snippets, not whole scraped pages: the model gets one search
                # per turn and a page of raw content each would crowd out the
                # conversation for no gain in answerability.
                "search_depth": "basic",
                "include_answer": False,
                "include_raw_content": False,
            },
            headers={"Authorization": f"Bearer {key}"},
            timeout=timeout or TIMEOUT_SECONDS,
        )
    except httpx.HTTPError as exc:
        raise TavilyUnavailable(f"network error: {exc}")

    if response.status_code == 401:
        raise TavilyUnavailable("Tavily rejected the API key.")
    if response.status_code == 429:
        raise TavilyUnavailable("Tavily monthly quota is exhausted.")
    if response.status_code != 200:
        raise TavilyUnavailable(f"Tavily returned HTTP {response.status_code}.")

    try:
        payload: Dict[str, Any] = response.json()
    except ValueError:
        raise TavilyUnavailable("Tavily returned a response that was not JSON.")

    results: List[Dict[str, str]] = []
    for row in payload.get("results", [])[:max_results]:
        url = str(row.get("url") or "").strip()
        if not url:
            continue
        results.append(
            {
                "title": str(row.get("title") or url).strip(),
                "url": url,
                # Tavily calls it "content"; the rest of the app calls the same
                # thing a snippet, and renames here rather than everywhere else.
                "snippet": str(row.get("content") or "").strip(),
            }
        )
    return results
