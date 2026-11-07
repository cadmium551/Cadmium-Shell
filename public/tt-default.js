if (window.trustedTypes && trustedTypes.createPolicy) {
  trustedTypes.createPolicy('default', {
    createScriptURL: (url) => {
      const u = new URL(url, location.href);
      const sameOrigin = u.origin === location.origin;
      const jsdelivrGh =
        u.origin === 'https://cdn.jsdelivr.net' && u.pathname.startsWith('/gh/');
      if (!sameOrigin && !jsdelivrGh) throw new TypeError('Blocked script URL: ' + url);
      return url;
    },
    createHTML: (html) => html,
    createScript: () => { throw new TypeError('eval-style script creation is blocked'); },
  });
}