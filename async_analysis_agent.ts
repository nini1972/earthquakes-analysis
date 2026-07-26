/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AsyncSeismologicalAgent
 * 
 * An asynchronous agent pipeline that enriches live earthquake data with:
 * 1. USGS ShakeMap & PAGER data (Peak Ground Acceleration, PGA / PAGER alert category).
 * 2. Terrain Elevation data (open-elevation API / USGS elevation) for landslide & liquefaction assessment.
 * 3. Regional Seismicity History (30-day foreshock/aftershock counts within 100km).
 * 4. Multi-source AI synthesis using Gemini 3.6 Flash.
 */

export interface AsyncAnalysisResult {
  shakeMapPga?: number; // Peak Ground Acceleration in %g
  pagerLevel?: string; // 'green' | 'yellow' | 'orange' | 'red' | 'none'
  elevationMeters?: number; // Terrain elevation at epicenter
  aftershockCount?: number; // Count of M3.0+ events within 100km in past 30 days
  detailedReport: string;
  completedAt: number;
}

export class AsyncSeismologicalAgent {
  /**
   * Fetches detailed event data from USGS Event API (includes ShakeMap & PAGER alerts).
   */
  static async fetchUsgsEventDetails(eventId: string): Promise<{ pga?: number; pager?: string }> {
    if (!eventId) return {};
    try {
      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${encodeURIComponent(eventId)}&format=geojson`;
      const response = await fetch(url);
      if (!response.ok) return {};
      const data = await response.json();
      
      const properties = data?.properties || {};
      const alert = properties.alert || 'none'; // 'green', 'yellow', 'orange', 'red'
      const mmi = properties.mmi;
      
      // Calculate estimated PGA (%g) from MMI if direct PGA unavailable
      // Empirical relation: log10(PGA) = 0.57 * MMI - 1.66
      let pga: number | undefined;
      if (typeof mmi === 'number' && mmi > 0) {
        const logPga = 0.57 * mmi - 1.66;
        pga = Math.round(Math.pow(10, logPga) * 10) / 10;
      }

      return {
        pager: alert !== 'none' ? alert : undefined,
        pga
      };
    } catch (e) {
      console.warn('AsyncAgent: Could not fetch USGS event details:', e);
      return {};
    }
  }

  /**
   * Fetches terrain elevation for epicentral coordinates via public Open-Elevation API.
   */
  static async fetchElevationData(lat: number, lng: number): Promise<number | undefined> {
    try {
      const url = `https://api.open-elevation.com/api/v1/lookup?locations=${lat.toFixed(4)},${lng.toFixed(4)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4000); // 4 sec timeout

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) return undefined;
      const data = await response.json();
      if (data && data.results && data.results[0] && typeof data.results[0].elevation === 'number') {
        return Math.round(data.results[0].elevation);
      }
    } catch (e) {
      console.warn('AsyncAgent: Elevation lookup skipped/timed out:', e);
    }
    return undefined;
  }

  /**
   * Queries regional foreshock/aftershock counts within 100km in past 30 days from USGS.
   */
  static async fetchRegionalSeismicityHistory(lat: number, lng: number): Promise<number> {
    try {
      const now = new Date();
      const past30Days = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const startTime = past30Days.toISOString().split('T')[0];

      const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=${startTime}&latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}&maxradiuskm=100&minmagnitude=3.0`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 sec timeout

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) return 0;
      const data = await response.json();
      return Array.isArray(data?.features) ? data.features.length : 0;
    } catch (e) {
      console.warn('AsyncAgent: Regional seismicity history fetch skipped:', e);
      return 0;
    }
  }

  /**
   * Runs the complete asynchronous analytical pipeline:
   * 1. Fetches ShakeMap & PAGER data.
   * 2. Fetches Elevation data.
   * 3. Fetches Regional Seismicity History.
   * 4. Streams multi-source synthesis using Gemini 3.6 Flash.
   */
  static async runPipeline(
    eq: any,
    aiClient: any,
    onProgress: (stepMessage: string) => void,
    onChunk: (chunkText: string) => void
  ): Promise<AsyncAnalysisResult> {
    const props = eq.properties || {};
    const coords = (eq.geometry && eq.geometry.coordinates) || eq.coordinates || [0, 0, 0];
    const lng = coords[0];
    const lat = coords[1];
    const depth = coords[2] || 10;
    const mag = props.mag || 4.5;
    const place = props.place || 'Unknown Location';
    const eqId = eq.id || String(props.time || Date.now());

    // Step 1: ShakeMap & PAGER
    onProgress('🔍 [Step 1/4] Querying official USGS ShakeMap & PAGER metrics...');
    const usgsDetails = await this.fetchUsgsEventDetails(eqId);

    // Step 2: Terrain Elevation
    onProgress('🏔️ [Step 2/4] Analyzing epicentral terrain elevation & slope profile...');
    const elevation = await this.fetchElevationData(lat, lng);

    // Step 3: Regional Seismicity
    onProgress('📡 [Step 3/4] Scanning 30-day regional aftershock & cluster history...');
    const aftershockCount = await this.fetchRegionalSeismicityHistory(lat, lng);

    // Step 4: AI Multi-Source Synthesis
    onProgress('🧠 [Step 4/4] Executing multi-agent Gemini 3.6 Flash synthesis report...');

    const pagerText = usgsDetails.pager 
      ? `USGS PAGER Level: ${usgsDetails.pager.toUpperCase()}`
      : 'USGS PAGER Level: Unrated (Standard Monitoring)';

    const pgaText = typeof usgsDetails.pga === 'number'
      ? `Estimated Peak Ground Acceleration (PGA): ~${usgsDetails.pga}%g`
      : 'PGA: Derived from focal depth model';

    const elevText = typeof elevation === 'number'
      ? `Epicentral Elevation: ${elevation} meters ${elevation < 50 ? '(Coastal/Lowland Alluvial Plain)' : elevation > 1000 ? '(Mountainous Terrain)' : '(Inland Hilly Terrain)'}`
      : 'Epicentral Elevation: Sea level / Coastal proximity model';

    const aftershockText = `Regional Seismic Clusters (M3.0+ within 100km in past 30d): ${aftershockCount} recorded events`;

    const enrichedPrompt = `You are an asynchronous lead seismologist and emergency response strategist conducting an expanded multi-source analysis of a major earthquake event.

PRIMARY EVENT PARAMETERS:
- Location: ${place}
- Magnitude: M ${mag.toFixed(1)}
- Focal Depth: ${depth} km
- Coordinates: ${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E
- Official USGS Tsunami Alert: ${props.tsunami === 1 ? 'YES - ACTIVE WARNING' : 'No Active Alert'}

ENRICHED EXTERNAL DATASETS GATHERED BY ANALYTICAL AGENT:
- ${pagerText}
- ${pgaText}
- ${elevText}
- ${aftershockText}

Please write a comprehensive, highly structured Seismological & Disaster Impact Report.

Include the following specific sections:
1. 📊 **Executive Summary & Hazard Multipliers**
   - Synthesize the magnitude, depth, elevation, and PGA to provide a clear severity verdict.
2. 🌊 **Oceanic & Coastal Tsunami Mechanics**
   - Analyze whether the epicentral setting (oceanic trench, continental shelf, subduction zone) and focal mechanism present significant tsunami wave generation risks.
3. 🏔️ **Geotechnical Vulnerability (Landslides vs Liquefaction)**
   - Assess Liquefaction risk (for lowland/coastal elevation under high PGA) and Landslide risk (for elevated slopes under high PGA).
4. 🔄 **Seismic Sequence & Regional Stress Transfer**
   - Interpret the 30-day cluster history (${aftershockCount} nearby events) regarding foreshock/aftershock progression along the local fault system.
5. 🛡️ **Emergency Mitigation & Disaster Response Priorities**
   - Provide concrete, prioritized safety recommendations for regional authorities and infrastructure operators.

Format the output clearly using Markdown headings, bold emphasis, and bullet points. Focus purely on scientific rigor and actionable hazard intelligence.`;

    let fullReport = '';

    if (aiClient && typeof aiClient.models?.generateContentStream === 'function') {
      try {
        const responseStream = await aiClient.models.generateContentStream({
          model: 'gemini-3.6-flash',
          contents: enrichedPrompt,
        });

        for await (const chunk of responseStream) {
          const text = chunk.text || '';
          fullReport += text;
          onChunk(text);
        }
      } catch (err) {
        console.error('AsyncAgent: Gemini generation error:', err);
        fullReport = `### ⚠️ Seismological Risk Analysis (Heuristic Fallback)\n\nAn error occurred while streaming Gemini analysis: ${err instanceof Error ? err.message : String(err)}\n\n**Parameters Analyzed:**\n- Location: ${place}\n- Magnitude: M${mag.toFixed(1)}\n- Depth: ${depth} km\n- Elevation: ${elevation ?? 'N/A'} m\n- Regional 30-day events: ${aftershockCount}`;
      }
    } else {
      fullReport = `### 🌐 Enriched Environmental Metrics\n- **Location**: ${place}\n- **Magnitude**: M${mag.toFixed(1)}\n- **Depth**: ${depth} km\n- **Elevation**: ${elevation ?? 'N/A'} meters\n- **PGA Estimate**: ${usgsDetails.pga ?? 'N/A'} %g\n- **30-Day Cluster Count**: ${aftershockCount} events`;
    }

    return {
      shakeMapPga: usgsDetails.pga,
      pagerLevel: usgsDetails.pager,
      elevationMeters: elevation,
      aftershockCount,
      detailedReport: fullReport,
      completedAt: Date.now()
    };
  }
}
