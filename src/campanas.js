// Origen del lead: resuelve el anuncio (ad_id) contra la Meta Marketing API y
// parsea el nombre de la campaña con la convención
//   KWPY | <FLUJO> | <ZONA o PROYECTO> | <ASESOR opcional>
const config = require('../config/kw-py');
const repo = require('./repo');

const GRAPH_VERSION = 'v21.0';
const TIMEOUT_MS = 4000;

// Devuelve { flujo, zona, asesor } o null si el nombre no respeta la convención.
function parseCampaignName(nombre) {
  if (!nombre) return null;
  const { prefijo, separador, flujos } = config.campanas;
  const partes = nombre.split(separador).map((p) => p.trim());
  if (partes.length < 3 || partes[0].toUpperCase() !== prefijo) return null;
  const flujo = flujos[partes[1].toUpperCase()];
  if (!flujo) return null;
  const valor = (v) => (v && v !== '-' ? v : null);
  return { flujo, zona: valor(partes[2]), asesor: valor(partes[3]) };
}

async function fetchAd(adId) {
  const token = process.env.META_SYSTEM_TOKEN;
  const fields = encodeURIComponent('name,adset{name},campaign{id,name}');
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(adId)}?fields=${fields}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Meta API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return {
    campaign_id: json.campaign?.id || null,
    campaign_name: json.campaign?.name || null,
    adset_name: json.adset?.name || null,
    ad_name: json.name || null,
  };
}

// Se llama una vez por lead que tiene ad_id y todavía no tiene campaign_status.
// Nunca lanza: si algo falla, el lead sigue igual y queda campaign_parse_failed.
async function resolveLeadCampaign(lead) {
  if (!lead.ad_id || lead.campaign_status) return lead;

  let ad = repo.findResolvedAd(lead.ad_id);
  if (!ad) {
    if (!process.env.META_SYSTEM_TOKEN) {
      repo.updateLead(lead.id, { campaign_status: 'sin_token' });
      repo.addEvent(lead.id, 'campaign_parse_failed', { ad_id: lead.ad_id, motivo: 'sin_token' });
      return repo.getLead(lead.id);
    }
    try {
      ad = await fetchAd(lead.ad_id);
    } catch (e) {
      console.error(`[campanas] No se pudo resolver el anuncio ${lead.ad_id}:`, e.message);
      repo.updateLead(lead.id, { campaign_status: 'api_failed' });
      repo.addEvent(lead.id, 'campaign_parse_failed', { ad_id: lead.ad_id, motivo: 'api', error: e.message });
      return repo.getLead(lead.id);
    }
  }

  const parsed = parseCampaignName(ad.campaign_name);
  const campos = { ...ad, campaign_status: parsed ? 'ok' : 'parse_failed' };
  if (parsed) {
    campos.campaign_flujo = parsed.flujo;
    campos.campaign_zona = parsed.zona;
    campos.campaign_asesor = parsed.asesor;
    // La pauta define el flujo: el agente arranca directo y confirma.
    if (!lead.flujo) {
      campos.flujo = parsed.flujo;
      campos.lead_type = config.flujos[parsed.flujo].lead_type;
    }
  }
  repo.updateLead(lead.id, campos);
  if (parsed) repo.addEvent(lead.id, 'campaign_resolved', { ad_id: lead.ad_id, ...ad, ...parsed });
  else repo.addEvent(lead.id, 'campaign_parse_failed', { ad_id: lead.ad_id, motivo: 'convencion', campaign_name: ad.campaign_name });
  return repo.getLead(lead.id);
}

module.exports = { parseCampaignName, resolveLeadCampaign };
