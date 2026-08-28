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
import re
from typing import Any, Dict, List, Optional

# pyrefly: ignore [missing-import]
import httpx

ENDPOINT = "https://api.tavily.com/search"

# Words that mean "as of now" rather than "in general".
#
# Tavily's default (general) topic returns undated results, and without a date
# on each one the model cannot tell a two-year-old article from this morning's
# -- so it falls back on what it already believes. Asked for "the latest news
# about the nepal flood" it answered about the September 2024 floods, from a
# result set that mixed 2000, 2015, 2019, 2024 and 2025, because nothing in the
# results said which was current.
#
# topic="news" fixes both halves: results come back dated and ranked by
# recency. It is not the default because it *forces* recency -- asked about the
# 2015 Nepal earthquake it returns this week's headlines instead of the event
# -- so it is used only when the question is actually about now.
_TIME_SENSITIVE = re.compile(
    r"\b(latest|newest|recent|recently|news|headlines?|today|tonight|yesterday"
    r"|current|currently|now|breaking|update[ds]?|so far|this (?:week|month|year))\b",
    re.IGNORECASE,
)


def is_time_sensitive(query: str) -> bool:
    return bool(_TIME_SENSITIVE.search(query or ""))

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

    payload: Dict[str, Any] = {
        "query": query,
        "max_results": max_results,
        # Snippets, not whole scraped pages: the model gets one search
        # per turn and a page of raw content each would crowd out the
        # conversation for no gain in answerability.
        "search_depth": "basic",
        "include_answer": False,
        "include_raw_content": False,
    }
    if is_time_sensitive(query):
        payload["topic"] = "news"

    try:
        response = httpx.post(
            ENDPOINT,
            json=payload,
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
        body: Dict[str, Any] = response.json()
    except ValueError:
        raise TavilyUnavailable("Tavily returned a response that was not JSON.")

    results: List[Dict[str, str]] = []
    for row in body.get("results", [])[:max_results]:
        url = str(row.get("url") or "").strip()
        if not url:
            continue
        result = {
            "title": str(row.get("title") or url).strip(),
            "url": url,
            # Tavily calls it "content"; the rest of the app calls the same
            # thing a snippet, and renames here rather than everywhere else.
            "snippet": str(row.get("content") or "").strip(),
        }
        # Only the news topic returns this. Passing it through is the whole
        # point of asking for that topic: an undated result set is what let the
        # model answer a "latest news" question from two-year-old memory,
        # because nothing in front of it said which article was current.
        published = str(row.get("published_date") or "").strip()
        if published:
            result["published"] = published
        results.append(result)
    return results
