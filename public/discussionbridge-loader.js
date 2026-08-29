(() => {
  for (const target of document.querySelectorAll("[data-discussionbridge-resource]")) {
    const resource = target.getAttribute("data-discussionbridge-resource");
    if (!/^[0-9a-f-]{36}$/i.test(resource || "")) continue;
    fetch(`/discussionbridge/presentation/${encodeURIComponent(resource)}`, { credentials: "same-origin", redirect: "error" })
      .then((response) => { if (!response.ok) throw new Error(); return response.text(); })
      .then((html) => { target.innerHTML = html; })
      .catch(() => { target.textContent = "Discussion is temporarily unavailable."; });
  }
})();
