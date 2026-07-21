/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines and runs an MCP (Model Context Protocol) server.
 * The server exposes tools that an AI model (like Gemini) can call to interact
 * with Google Maps functionality. These tools include:
 * - `view_location_google_maps`: To display a specific location.
 * - `directions_on_google_maps`: To get and display directions.
 *
 * When the AI decides to use one of these tools, the MCP server receives the
 * call and then uses the `mapQueryHandler` callback to send the relevant
 * parameters (location, origin/destination) to the frontend
 * (MapApp component in map_app.ts) to update the map display.
 */

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {z} from 'zod';

export interface MapParams {
  location?: string;
  origin?: string;
  destination?: string;
  showEarthquakes?: string;
  analyzeEarthquake?: string;
}

export async function startMcpGoogleMapServer(
  transport: Transport,
  /**
   * Callback function provided by the frontend (index.tsx) to handle map updates.
   * This function is invoked when an AI tool call requires a map interaction,
   * passing the necessary parameters to update the map view (e.g., show location,
   * display directions). It is the bridge between MCP server tool execution and
   * the visual map representation in the MapApp component.
   */
  mapQueryHandler: (params: MapParams) => void,
) {
  // Create an MCP server
  const server = new McpServer({
    name: 'AI Studio Google Map',
    version: '1.0.0',
  });

  server.tool(
    'view_location_google_maps',
    'View a specific query or geographical location and display in the embedded maps interface',
    {query: z.string()},
    async ({query}) => {
      mapQueryHandler({location: query});
      return {
        content: [{type: 'text', text: `Navigating to: ${query}`}],
      };
    },
  );

  server.tool(
    'directions_on_google_maps',
    'Search google maps for directions from origin to destination.',
    {origin: z.string(), destination: z.string()},
    async ({origin, destination}) => {
      mapQueryHandler({origin, destination});
      return {
        content: [
          {type: 'text', text: `Navigating from ${origin} to ${destination}`},
        ],
      };
    },
  );

  server.tool(
    'get_live_earthquakes',
    'Fetch and display live heavy earthquakes (M4.5+) on the global map.',
    {
      feedType: z.enum(['day', 'week', 'significant']).default('day').describe('The filter selection: day (Past 24 hours M4.5+), week (Past 7 days M4.5+), or significant (Past 7 days significant events)'),
    },
    async ({feedType}) => {
      mapQueryHandler({showEarthquakes: feedType});
      return {
        content: [{type: 'text', text: `Fetched and plotted live earthquakes (${feedType}) on the global map.`}],
      };
    },
  );

  server.tool(
    'analyze_earthquake_risk',
    'Select, focus on, and analyze the hazard/disaster potential (Tsunami, soil liquefaction, landslide) of a specific earthquake.',
    {
      query: z.string().describe('Search query matching the earthquake place, region, or magnitude, e.g., "Japan", "M 6.1", "California"'),
    },
    async ({query}) => {
      mapQueryHandler({analyzeEarthquake: query});
      return {
        content: [{type: 'text', text: `Searching and running disaster risk analysis for earthquake: ${query}`}],
      };
    },
  );

  await server.connect(transport);
  console.log('server running');
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
