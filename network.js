// Évite une attente indéfinie quand le serveur ou le réseau ne répond plus.
const originalFetch = window.fetch.bind(window);
window.fetch = async function(input, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try { return await originalFetch(input, {...options, signal: options.signal || controller.signal}); }
  catch (error) { if (error.name === 'AbortError') throw new Error('Le serveur ne répond pas. Vérifiez la connexion puis réessayez.'); throw error; }
  finally { clearTimeout(timer); }
};
