/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This file defines the main `gdm-map-app` LitElement component.
 * This component is responsible for:
 * - Rendering the user interface, including the Google Photorealistic 3D Map,
 *   chat messages area, and user input field.
 * - Managing the state of the chat (e.g., idle, generating, thinking).
 * - Handling user input and sending messages to the Gemini AI model.
 * - Processing responses from the AI, including displaying text and handling
 *   function calls (tool usage) related to map interactions.
 * - Integrating with the Google Maps JavaScript API to load and control the map,
 *   display markers, polylines for routes, and geocode locations.
 * - Providing the `handleMapQuery` method, which is called by the MCP server
 *   (via index.tsx) to update the map based on AI tool invocations.
 */

// Google Maps JS API Loader: Used to load the Google Maps JavaScript API.
import {Loader} from '@googlemaps/js-api-loader';
import hljs from 'highlight.js';
import {html, LitElement, PropertyValueMap} from 'lit';
import {customElement, query, state} from 'lit/decorators.js';
import {classMap} from 'lit/directives/class-map.js';
import {Marked} from 'marked';
import {markedHighlight} from 'marked-highlight';
import {unsafeHTML} from 'lit/directives/unsafe-html.js';
import {GoogleGenAI} from '@google/genai';

import {MapParams} from './mcp_maps_server';

/** Markdown formatting function with syntax hilighting */
export const marked = new Marked(
  markedHighlight({
    async: true,
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang, info) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, {language}).value;
    },
  }),
);

const ICON_BUSY = html`<svg
  class="rotating"
  xmlns="http://www.w3.org/2000/svg"
  height="24px"
  viewBox="0 -960 960 960"
  width="24px"
  fill="currentColor">
  <path
    d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 31.5-155.5t86-127Q252-817 325-848.5T480-880q17 0 28.5 11.5T520-840q0 17-11.5 28.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160q133 0 226.5-93.5T800-480q0-17 11.5-28.5T840-520q17 0 28.5 11.5T880-480q0 82-31.5 155t-86 127.5q-54.5 54.5-127 86T480-80Z" />
</svg>`;

/**
 * Chat state enum to manage the current state of the chat interface.
 */
export enum ChatState {
  IDLE,
  GENERATING,
  THINKING,
  EXECUTING,
}

/**
 * Chat tab enum to manage the current selected tab in the chat interface.
 */
export enum ChatTab {
  GEMINI,
  EARTHQUAKES,
}

/**
 * Chat role enum to manage the current role of the message.
 */
export enum ChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

// Google Maps API Key: Replace with your actual Google Maps API key.
// This key is essential for loading and using Google Maps services.
// Ensure this key is configured with access to the "Maps JavaScript API",
// "Geocoding API", and the "Directions API".
const USER_PROVIDED_GOOGLE_MAPS_API_KEY: string =
  'AIzaSyAJPTwj4S8isr4b-3NtqVSxk450IAS1lOQ'; // <-- REPLACE THIS WITH YOUR ACTUAL API KEY

const EXAMPLE_PROMPTS = [
  "Show me directions from Tokyo Tower to Shibuya Crossing.",
  "Can you show me a beautiful beach?",
  "Show me San Francisco",
  "Give me directions from the Eiffel Tower to the Louvre Museum.",
  "Where is a place with a tilted tower?",
  "Can you show me Diamond Head in Hawaii?",
  "Let's go to Venice, Italy.",
  "Take me to the northernmost capital city in the world",
  "What's the way from Buckingham Palace to the Tower of London?",
  "How about the southernmost permanently inhabited settlement? What's it called and where is it?",
  "Let's jump to Machu Picchu in Peru",
  "Can you show me the Three Gorges Dam in China?",
  "Can you find a town or city with an unusual name and show it to me?",
  "How do I get from Times Square, New York to Central Park?",
  "Show me the route from the Golden Gate Bridge to Alcatraz Island.",
];

/**
 * MapApp component for Photorealistic 3D Maps.
 */
@customElement('gdm-map-app')
export class MapApp extends LitElement {
  @query('#anchor') anchor?: HTMLDivElement;
  // Google Maps: Reference to the <gmp-map-3d> DOM element where the map is rendered.
  @query('#mapContainer') mapContainerElement?: HTMLElement; // Will be <gmp-map-3d>
  @query('#messageInput') messageInputElement?: HTMLInputElement;

  @state() chatState = ChatState.IDLE;
  @state() isRunning = true;
  @state() selectedChatTab = ChatTab.GEMINI;
  @state() inputMessage = '';
  @state() messages: HTMLElement[] = [];
  @state() mapInitialized = false;
  @state() mapError = '';

  // Live Earthquakes Dashboard State
  @state() earthquakes: any[] = [];
  @state() earthquakesLoading = false;
  @state() selectedEarthquake: any = null;
  @state() filterTimeframe = 'day'; // 'day', 'week', 'significant'
  @state() analysisReport = '';
  @state() analysisLoading = false;

  private earthquakeMarkers: any[] = [];
  private aiClient?: GoogleGenAI;

  // Google Maps: Instance of the Google Maps 3D map.
  private map?: any;
  // Google Maps: Instance of the Google Maps Geocoding service.
  private geocoder?: any;
  // Google Maps: Instance of the current map marker (Marker3DElement).
  private marker?: any;

  // Google Maps: References to 3D map element constructors.
  private Map3DElement?: any;
  private Marker3DElement?: any;
  private Polyline3DElement?: any;

  // Google Maps: Instance of the Google Maps Directions service.
  private directionsService?: any;
  // Google Maps: Instance of the current route polyline.
  private routePolyline?: any;
  // Google Maps: Markers for origin and destination of a route.
  private originMarker?: any;
  private destinationMarker?: any;

  sendMessageHandler?: CallableFunction;

  constructor() {
    super();
    // Set initial input from a random example prompt
    this.setNewRandomPrompt();
  }

  createRenderRoot() {
    return this;
  }

  protected firstUpdated(
    _changedProperties: PropertyValueMap<any> | Map<PropertyKey, unknown>,
  ): void {
    // Google Maps: Load the map when the component is first updated.
    this.loadMap();
  }

  /**
   * Sets the input message to a new random prompt from EXAMPLE_PROMPTS.
   */
  private setNewRandomPrompt() {
    if (EXAMPLE_PROMPTS.length > 0) {
      this.inputMessage =
        EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    }
  }

  /**
   * Google Maps: Loads the Google Maps JavaScript API using the JS API Loader.
   * It initializes necessary map services like Geocoding and Directions,
   * and imports 3D map elements (Map3DElement, Marker3DElement, Polyline3DElement).
   * Handles API key validation and error reporting.
   */
  async loadMap() {
    const isApiKeyPlaceholder =
      USER_PROVIDED_GOOGLE_MAPS_API_KEY ===
        'YOUR_ACTUAL_GOOGLE_MAPS_API_KEY_REPLACE_ME' ||
      USER_PROVIDED_GOOGLE_MAPS_API_KEY === '';

    if (isApiKeyPlaceholder) {
      this.mapError = `Google Maps API Key is not configured correctly.
Please edit the map_app.ts file and replace the placeholder value for
USER_PROVIDED_GOOGLE_MAPS_API_KEY with your actual API key.
You can find this constant near the top of the map_app.ts file.`;
      console.error(this.mapError);
      this.requestUpdate();
      return;
    }

    const loader = new Loader({
      apiKey: USER_PROVIDED_GOOGLE_MAPS_API_KEY,
      version: 'beta', // Using 'beta' for Photorealistic 3D Maps features
      libraries: ['geocoding', 'routes', 'geometry'], // Request necessary libraries
    });

    try {
      await loader.load();
      // Google Maps: Import 3D map specific library elements.
      const maps3dLibrary = await (window as any).google.maps.importLibrary(
        'maps3d',
      );
      this.Map3DElement = maps3dLibrary.Map3DElement;
      this.Marker3DElement = maps3dLibrary.Marker3DElement;
      this.Polyline3DElement = maps3dLibrary.Polyline3DElement;

      if ((window as any).google && (window as any).google.maps) {
        // Google Maps: Initialize the DirectionsService.
        this.directionsService = new (
          window as any
        ).google.maps.DirectionsService();
      } else {
        console.error('DirectionsService not loaded.');
      }

      // Google Maps: Initialize the map itself.
      this.initializeMap();
      this.mapInitialized = true;
      this.mapError = '';
      
      // Auto-load live heavy earthquakes on start
      this.fetchEarthquakes();
    } catch (error) {
      console.error('Error loading Google Maps API:', error);
      this.mapError =
        'Could not load Google Maps. Check console for details and ensure API key is correct. If using 3D features, ensure any necessary Map ID is correctly configured if required programmatically.';
      this.mapInitialized = false;
    }
    this.requestUpdate();
  }

  /**
   * Google Maps: Initializes the map instance and the Geocoder service.
   * This is called after the Google Maps API has been successfully loaded.
   */
  initializeMap() {
    if (!this.mapContainerElement || !this.Map3DElement) {
      console.error('Map container or Map3DElement class not ready.');
      return;
    }
    // Google Maps: Assign the <gmp-map-3d> element to the map property.
    this.map = this.mapContainerElement;
    if ((window as any).google && (window as any).google.maps) {
      // Google Maps: Initialize the Geocoder.
      this.geocoder = new (window as any).google.maps.Geocoder();
    } else {
      console.error('Geocoder not loaded.');
    }
  }

  setChatState(state: ChatState) {
    this.chatState = state;
  }

  /**
   * Google Maps: Clears existing map elements like markers and polylines
   * before adding new ones. This ensures the map doesn't get cluttered with
   * old search results or routes.
   */
  private _clearMapElements() {
    if (this.marker) {
      this.marker.remove();
      this.marker = undefined;
    }
    if (this.routePolyline) {
      this.routePolyline.remove();
      this.routePolyline = undefined;
    }
    if (this.originMarker) {
      this.originMarker.remove();
      this.originMarker = undefined;
    }
    if (this.destinationMarker) {
      this.destinationMarker.remove();
      this.destinationMarker = undefined;
    }
  }

  /**
   * Google Maps: Handles viewing a specific location on the map.
   * It uses the Geocoding service to find coordinates for the `locationQuery`,
   * then flies the camera to that location and places a 3D marker.
   * @param locationQuery The string query for the location (e.g., "Eiffel Tower").
   */
  private async _handleViewLocation(locationQuery: string) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.geocoder ||
      !this.Marker3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready to display locations. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized, geocoder or Marker3DElement not available, cannot render query.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use Geocoding service to find the location.
    this.geocoder.geocode(
      {address: locationQuery},
      async (results: any, status: string) => {
        if (status === 'OK' && results && results[0] && this.map) {
          const location = results[0].geometry.location;

          // Google Maps: Define camera options and fly to the location.
          const cameraOptions = {
            center: {lat: location.lat(), lng: location.lng(), altitude: 0},
            heading: 0,
            tilt: 67.5,
            range: 2000, // Distance from the target in meters
          };
          (this.map as any).flyCameraTo({
            endCamera: cameraOptions,
            durationMillis: 1500,
          });

          // Google Maps: Create and add a 3D marker to the map.
          this.marker = new this.Marker3DElement();
          this.marker.position = {
            lat: location.lat(),
            lng: location.lng(),
            altitude: 0,
          };
          const label =
            locationQuery.length > 30
              ? locationQuery.substring(0, 27) + '...'
              : locationQuery;
          this.marker.label = label;
          (this.map as any).appendChild(this.marker);
        } else {
          console.error(
            `Geocode was not successful for "${locationQuery}". Reason: ${status}`,
          );
          const rawErrorMessage = `Could not find location: ${locationQuery}. Reason: ${status}`;
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(rawErrorMessage);
        }
      },
    );
  }

  /**
   * Google Maps: Handles displaying directions between an origin and destination.
   * It uses the DirectionsService to calculate the route, then draws a 3D polyline
   * for the route and places 3D markers at the origin and destination.
   * The camera is adjusted to fit the entire route.
   * @param originQuery The starting point for directions.
   * @param destinationQuery The ending point for directions.
   */
  private async _handleDirections(
    originQuery: string,
    destinationQuery: string,
  ) {
    if (
      !this.mapInitialized ||
      !this.map ||
      !this.directionsService ||
      !this.Marker3DElement ||
      !this.Polyline3DElement
    ) {
      if (!this.mapError) {
        const {textElement} = this.addMessage('error', 'Processing error...');
        textElement.innerHTML = await marked.parse(
          'Map is not ready for directions. Please check configuration.',
        );
      }
      console.warn(
        'Map not initialized or DirectionsService/3D elements not available, cannot render directions.',
      );
      return;
    }
    this._clearMapElements(); // Google Maps: Clear previous elements.

    // Google Maps: Use DirectionsService to get the route.
    this.directionsService.route(
      {
        origin: originQuery,
        destination: destinationQuery,
        travelMode: (window as any).google.maps.TravelMode.DRIVING,
      },
      async (response: any, status: string) => {
        if (
          status === 'OK' &&
          response &&
          response.routes &&
          response.routes.length > 0
        ) {
          const route = response.routes[0];

          // Google Maps: Draw the route polyline using Polyline3DElement.
          if (route.overview_path && this.Polyline3DElement) {
            const pathCoordinates = route.overview_path.map((p: any) => ({
              lat: p.lat(),
              lng: p.lng(),
              altitude: 5,
            })); // Add slight altitude
            this.routePolyline = new this.Polyline3DElement();
            this.routePolyline.coordinates = pathCoordinates;
            this.routePolyline.strokeColor = 'blue';
            this.routePolyline.strokeWidth = 10;
            (this.map as any).appendChild(this.routePolyline);
          }

          // Google Maps: Add marker for the origin.
          if (
            route.legs &&
            route.legs[0] &&
            route.legs[0].start_location &&
            this.Marker3DElement
          ) {
            const originLocation = route.legs[0].start_location;
            this.originMarker = new this.Marker3DElement();
            this.originMarker.position = {
              lat: originLocation.lat(),
              lng: originLocation.lng(),
              altitude: 0,
            };
            this.originMarker.label = 'Origin';
            this.originMarker.style = {
              color: {r: 0, g: 128, b: 0, a: 1}, // Green
            };
            (this.map as any).appendChild(this.originMarker);
          }

          // Google Maps: Add marker for the destination.
          if (
            route.legs &&
            route.legs[0] &&
            route.legs[0].end_location &&
            this.Marker3DElement
          ) {
            const destinationLocation = route.legs[0].end_location;
            this.destinationMarker = new this.Marker3DElement();
            this.destinationMarker.position = {
              lat: destinationLocation.lat(),
              lng: destinationLocation.lng(),
              altitude: 0,
            };
            this.destinationMarker.label = 'Destination';
            this.destinationMarker.style = {
              color: {r: 255, g: 0, b: 0, a: 1}, // Red
            };
            (this.map as any).appendChild(this.destinationMarker);
          }

          // Google Maps: Adjust camera to fit the route bounds.
          if (route.bounds) {
            const bounds = route.bounds;
            const center = bounds.getCenter();
            let range = 10000; // Default range

            // Calculate a more appropriate range based on the route's diagonal distance
            if (
              (window as any).google.maps.geometry &&
              (window as any).google.maps.geometry.spherical
            ) {
              const spherical = (window as any).google.maps.geometry.spherical;
              const ne = bounds.getNorthEast();
              const sw = bounds.getSouthWest();
              const diagonalDistance = spherical.computeDistanceBetween(ne, sw);
              range = diagonalDistance * 1.7; // Multiplier to ensure bounds are visible
            } else {
              console.warn(
                'google.maps.geometry.spherical not available for range calculation. Using fallback range.',
              );
            }

            range = Math.max(range, 2000); // Ensure a minimum sensible range

            const cameraOptions = {
              center: {lat: center.lat(), lng: center.lng(), altitude: 0},
              heading: 0,
              tilt: 45, // Tilt for better 3D perspective of the route
              range: range,
            };
            (this.map as any).flyCameraTo({
              endCamera: cameraOptions,
              durationMillis: 2000,
            });
          }
        } else {
          console.error(
            `Directions request failed. Origin: "${originQuery}", Destination: "${destinationQuery}". Status: ${status}. Response:`,
            response,
          );
          const rawErrorMessage = `Could not get directions from "${originQuery}" to "${destinationQuery}". Reason: ${status}`;
          const {textElement} = this.addMessage('error', 'Processing error...');
          textElement.innerHTML = await marked.parse(rawErrorMessage);
        }
      },
    );
  }

  /**
   * Google Maps: This function is the primary interface for the MCP server (via index.tsx)
   * to trigger updates on the Google Map. When the AI model uses a map-related tool
   * (e.g., view location, get directions), the MCP server processes this request
   * and calls this function with the appropriate parameters.
   *
   * Based on the `params` received, this function will:
   * - If `params.location` is present, call `_handleViewLocation` to show a specific place.
   * - If `params.origin` and `params.destination` are present, call `_handleDirections`
   *   to display a route.
   * - If only `params.destination` is present (as a fallback), it will treat it as a location to view.
   *
   * This mechanism allows the AI's tool usage to be directly reflected on the map UI.
   * @param params An object containing parameters for the map query, like
   *               `location`, `origin`, or `destination`.
   */
  async handleMapQuery(params: MapParams) {
    if (params.showEarthquakes) {
      this.selectedChatTab = ChatTab.EARTHQUAKES;
      await this.fetchEarthquakes(params.showEarthquakes);
    } else if (params.analyzeEarthquake) {
      this.selectedChatTab = ChatTab.EARTHQUAKES;
      await this._handleAnalyzeEarthquakeQuery(params.analyzeEarthquake);
    } else if (params.location) {
      this._handleViewLocation(params.location);
    } else if (params.origin && params.destination) {
      this._handleDirections(params.origin, params.destination);
    } else if (params.destination) {
      // Fallback if only destination is provided, treat as viewing a location
      this._handleViewLocation(params.destination);
    }
  }

  setInputField(message: string) {
    this.inputMessage = message.trim();
  }

  addMessage(role: string, message: string) {
    const div = document.createElement('div');
    div.classList.add('turn');
    div.classList.add(`role-${role.trim()}`);
    div.setAttribute('aria-live', 'polite');

    const thinkingDetails = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Thinking process';
    thinkingDetails.classList.add('thinking');
    thinkingDetails.setAttribute('aria-label', 'Model thinking process');
    const thinkingElement = document.createElement('div');
    thinkingDetails.append(summary);
    thinkingDetails.append(thinkingElement);
    div.append(thinkingDetails);

    const textElement = document.createElement('div');
    textElement.className = 'text';
    textElement.innerHTML = message;
    div.append(textElement);

    this.messages = [...this.messages, div];
    this.scrollToTheEnd();
    return {
      thinkingContainer: thinkingDetails,
      thinkingElement: thinkingElement,
      textElement: textElement,
    };
  }

  scrollToTheEnd() {
    if (!this.anchor) return;
    this.anchor.scrollIntoView({
      behavior: 'smooth',
      block: 'end',
    });
  }

  async sendMessageAction(message?: string, role?: string) {
    if (this.chatState !== ChatState.IDLE) return;

    let msg = '';
    let usedComponentInput = false; // Flag to track if component's input was used

    if (message) {
      // Message is provided programmatically
      msg = message.trim();
    } else {
      // Message from the UI input field
      msg = this.inputMessage.trim();
      // Clear the input field state only if we are using its content
      // and there was actual content to send.
      if (msg.length > 0) {
        this.inputMessage = '';
        usedComponentInput = true;
      } else if (
        this.inputMessage.trim().length === 0 &&
        this.inputMessage.length > 0
      ) {
        // If inputMessage contained only whitespace, clear it and mark as used.
        this.inputMessage = '';
        usedComponentInput = true;
      }
    }

    if (msg.length === 0) {
      // If the final message to send is empty (e.g., user entered only spaces, or an empty programmatic message)
      // set a new random prompt if the component's input was cleared.
      if (usedComponentInput) {
        this.setNewRandomPrompt();
      }
      return;
    }

    const msgRole = role ? role.toLowerCase() : 'user';

    // Add user's message to the chat display
    if (msgRole === 'user' && msg) {
      const {textElement} = this.addMessage(msgRole, '...');
      textElement.innerHTML = await marked.parse(msg);
    }

    // Send the message via the handler (to AI)
    if (this.sendMessageHandler) {
      await this.sendMessageHandler(msg, msgRole);
    }

    // If the component's main input field was used and cleared, set a new random prompt.
    if (usedComponentInput) {
      this.setNewRandomPrompt();
    }
  }

  private async inputKeyDownAction(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessageAction();
    }
  }

  private getAiClient() {
    if (!this.aiClient) {
      const apiKey = (process.env as any).GEMINI_API_KEY || (process.env as any).API_KEY;
      this.aiClient = new GoogleGenAI({
        apiKey: apiKey || '',
      });
    }
    return this.aiClient;
  }

  async fetchEarthquakes(feedType?: string) {
    if (feedType) {
      this.filterTimeframe = feedType;
    }
    this.earthquakesLoading = true;
    this.requestUpdate();

    let url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
    if (this.filterTimeframe === 'week') {
      url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';
    } else if (this.filterTimeframe === 'significant') {
      url = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_week.geojson';
    }

    try {
      const response = await fetch(url);
      const data = await response.json();
      if (data && data.features) {
        this.earthquakes = data.features.sort((a: any, b: any) => {
          if (b.properties.mag !== a.properties.mag) {
            return b.properties.mag - a.properties.mag;
          }
          return b.properties.time - a.properties.time;
        });
        await this.plotEarthquakesOnMap();
      }
    } catch (error) {
      console.error('Failed to fetch earthquakes:', error);
    } finally {
      this.earthquakesLoading = false;
      this.requestUpdate();
    }
  }

  async plotEarthquakesOnMap() {
    if (!this.mapInitialized || !this.map || !this.Marker3DElement) {
      console.warn('Map not ready for plotting earthquakes.');
      return;
    }

    this.earthquakeMarkers.forEach((m) => m.remove());
    this.earthquakeMarkers = [];
    this._clearMapElements();

    for (const eq of this.earthquakes) {
      const coords = eq.geometry.coordinates;
      const mag = eq.properties.mag;

      let color = { r: 245, g: 158, b: 11, a: 1.0 };
      if (mag >= 6.0) {
        color = { r: 239, g: 68, b: 68, a: 1.0 };
      } else if (mag >= 5.0) {
        color = { r: 249, g: 115, b: 22, a: 1.0 };
      }

      const marker = new this.Marker3DElement();
      marker.position = {
        lat: coords[1],
        lng: coords[0],
        altitude: 0,
      };
      
      const roundedMag = typeof mag === 'number' ? mag.toFixed(1) : '?.?';
      marker.label = `M${roundedMag}`;
      marker.style = { color };

      const handleMarkerClick = () => {
        this.selectEarthquake(eq);
      };
      marker.addEventListener('click', handleMarkerClick);
      marker.addEventListener('gmp-click', handleMarkerClick);

      (this.map as any).appendChild(marker);
      this.earthquakeMarkers.push(marker);
    }

    if (this.earthquakes.length > 0 && !this.selectedEarthquake) {
      const firstEq = this.earthquakes[0];
      const coords = firstEq.geometry.coordinates;
      (this.map as any).flyCameraTo({
        endCamera: {
          center: { lat: coords[1], lng: coords[0], altitude: 0 },
          heading: 0,
          tilt: 30,
          range: 8000000,
        },
        durationMillis: 2500,
      });
    }
  }

  async selectEarthquake(eq: any) {
    this.selectedEarthquake = eq;
    this.selectedChatTab = ChatTab.EARTHQUAKES;
    this.requestUpdate();

    if (this.map && this.mapInitialized) {
      const coords = eq.geometry.coordinates;
      (this.map as any).flyCameraTo({
        endCamera: {
          center: { lat: coords[1], lng: coords[0], altitude: 0 },
          heading: 0,
          tilt: 60,
          range: 200000,
        },
        durationMillis: 2000,
      });
    }

    await this.runDisasterRiskAnalysis(eq);
  }

  async _handleAnalyzeEarthquakeQuery(queryStr: string) {
    if (this.earthquakes.length === 0) {
      await this.fetchEarthquakes('week');
    }

    const lowerQuery = queryStr.toLowerCase();
    let match = this.earthquakes.find((eq) => 
      eq.properties.place.toLowerCase().includes(lowerQuery)
    );

    if (!match) {
      const magMatch = queryStr.match(/\d+(\.\d+)?/);
      if (magMatch) {
        const queryMag = parseFloat(magMatch[0]);
        match = this.earthquakes.find((eq) => 
          Math.abs(eq.properties.mag - queryMag) < 0.2
        );
      }
    }

    if (match) {
      await this.selectEarthquake(match);
    } else {
      console.warn(`Could not find earthquake matching query: "${queryStr}"`);
      this._handleViewLocation(queryStr);
      const {textElement} = this.addMessage('assistant', '');
      textElement.innerHTML = await marked.parse(
        `I searched our active earthquake lists for **"${queryStr}"** but didn't find an exact match. I've focused the map on **"${queryStr}"** so we can examine the region's seismic profile.`
      );
    }
  }

  async runDisasterRiskAnalysis(eq: any) {
    const ai = this.getAiClient();
    if (!ai) {
      this.analysisReport = 'Gemini API key is not configured. Please add your key to Secrets.';
      this.requestUpdate();
      return;
    }

    const properties = eq.properties;
    const coords = eq.geometry.coordinates;
    const magnitude = properties.mag;
    const depth = coords[2];
    const place = properties.place;
    const tsunamiFlag = properties.tsunami;
    const sig = properties.sig;

    this.analysisLoading = true;
    this.analysisReport = '';
    this.requestUpdate();

    const prompt = `You are an expert seismologist and disaster prevention specialist. Analyze the following live earthquake event for disaster potential:
- Location: ${place}
- Magnitude: M ${magnitude.toFixed(1)}
- Depth: ${depth} km
- Coordinates: Latitude ${coords[1].toFixed(4)}, Longitude ${coords[0].toFixed(4)}
- USGS Tsunami Alert: ${tsunamiFlag === 1 ? 'Yes, Alert Active' : 'No Active Alert'}
- USGS Significance Score: ${sig}/1000

Please generate a detailed, highly scannable seismology and disaster risk report.
Analyze and cover:
1. **Tsunami Risk**: Calculate tsunami generation risk based on epicentral location (oceanic, coastal, or continental) and magnitude/depth.
2. **Ground Displacement & Liquefaction**: Assess soil liquefaction hazards in surrounding coastal or alluvial basins and landslides in steep/mountainous slopes.
3. **Historical context or tectonic context**: e.g., Plate boundary involved (Pacific plate subduction, strike-slip, etc.).
4. **Disaster Mitigation Advice**: Immediate structural safety, secondary hazard threats (fires, structural collapses, coastal evacuation advice).

Return your response in a highly professional scientific format using markdown headings, bold accents, and clear bullet points. Do not include unrequested technical data (like system coordinates, server details, or port numbers). Keep it focused purely on the seismological hazards and risks.`;

    try {
      const responseStream = await ai.models.generateContentStream({
        model: 'gemini-3.5-flash',
        contents: prompt,
      });

      for await (const chunk of responseStream) {
        this.analysisReport += chunk.text || '';
        this.requestUpdate();
      }
    } catch (error) {
      console.error('Failed to generate disaster analysis:', error);
      this.analysisReport = 'An error occurred while generating the AI disaster potential analysis. Please check your API configuration and try again.';
    } finally {
      this.analysisLoading = false;
      this.requestUpdate();
    }
  }

  calculateHeuristicMetrics(eq: any) {
    if (!eq) return { tsunami: 0, liquefaction: 0, landslide: 0, structural: 0 };
    const mag = eq.properties.mag || 4.5;
    const depth = eq.geometry.coordinates[2] || 10;
    const tsunamiFlag = eq.properties.tsunami;
    const placeLower = (eq.properties.place || '').toLowerCase();

    let tsunamiRisk = 0;
    if (tsunamiFlag === 1) {
      tsunamiRisk = 95;
    } else {
      const waterKeywords = ['ocean', 'sea', 'coast', 'gulf', 'bay', 'island', 'pacific', 'atlantic', 'indian', 'fiji', 'tonga', 'mariana', 'chile', 'indonesia', 'philippines', 'japan', 'taiwan', 'papua', 'solomon', 'vanuatu', 'hawaii', 'alaska'];
      const isNearWater = waterKeywords.some(w => placeLower.includes(w));
      
      if (isNearWater) {
        if (mag >= 7.0 && depth <= 50) {
          tsunamiRisk = 85;
        } else if (mag >= 6.0 && depth <= 70) {
          tsunamiRisk = 55;
        } else if (mag >= 5.0 && depth <= 100) {
          tsunamiRisk = 25;
        } else {
          tsunamiRisk = 5;
        }
      } else {
        tsunamiRisk = 0;
      }
    }

    let liqRisk = 0;
    const wetKeywords = ['river', 'coastal', 'bay', 'valley', 'basin', 'swamp', 'lake', 'port', 'harbor', 'beach', 'tokyo', 'san francisco', 'los angeles', 'manila', 'jakarta'];
    const isWetSoil = wetKeywords.some(w => placeLower.includes(w));
    liqRisk = Math.max(0, Math.min(100, Math.round((mag - 4.5) * 22 - (depth / 100) * 15 + (isWetSoil ? 20 : 0))));

    let slideRisk = 0;
    const mountainousKeywords = ['mountain', 'mount', 'hill', 'ridge', 'valley', 'volcano', 'chile', 'peru', 'nepal', 'indonesia', 'taiwan', 'japan', 'alaska', 'papua', 'italy', 'greece'];
    const isMountainous = mountainousKeywords.some(m => placeLower.includes(m));
    slideRisk = Math.max(0, Math.min(100, Math.round((mag - 4.5) * 20 - (depth / 100) * 10 + (isMountainous ? 30 : 0))));

    let structRisk = 0;
    structRisk = Math.max(0, Math.min(100, Math.round((mag - 4.0) * 25 - (depth / 80) * 20)));

    return {
      tsunami: tsunamiRisk,
      liquefaction: liqRisk,
      landslide: slideRisk,
      structural: structRisk
    };
  }

  renderMarkdown(text: string) {
    try {
      const htmlStr = (marked as any).parseSync ? (marked as any).parseSync(text) : text;
      return unsafeHTML(htmlStr);
    } catch (e) {
      return text;
    }
  }

  downloadReport() {
    if (!this.selectedEarthquake) return;
    
    const eq = this.selectedEarthquake;
    const properties = eq.properties;
    const coords = eq.geometry.coordinates;
    const place = properties.place || 'Unknown Location';
    const magnitude = properties.mag || 0.0;
    const depth = coords[2] || 0;
    const timestamp = new Date(properties.time).toLocaleString();
    const tsunamiAlert = properties.tsunami === 1 ? 'YES (Active Alert)' : 'No Active Alert';
    const sig = properties.sig || 0;

    const metrics = this.calculateHeuristicMetrics(eq);
    const currentDate = new Date().toLocaleString();

    const reportContent = `================================================================================
🌍 SEISMOLOGICAL RISK & HAZARD ASSESSMENT REPORT
================================================================================

[EVENT DETAILS]
--------------------------------------------------------------------------------
• Location:          ${place}
• Magnitude:         M ${magnitude.toFixed(1)}
• Depth:             ${depth.toFixed(1)} km
• Coordinates:       Latitude ${coords[1].toFixed(4)}°, Longitude ${coords[0].toFixed(4)}°
• Timestamp:         ${timestamp}
• USGS Tsunami Alert: ${tsunamiAlert}
• USGS Sig Score:    ${sig}/1000

[DYNAMIC HAZARD EVALUATION]
--------------------------------------------------------------------------------
🌊 Tsunami Risk:         ${metrics.tsunami}%
💧 Liquefaction Hazard:  ${metrics.liquefaction}%
⛰️ Landslide Hazard:     ${metrics.landslide}%
🏢 Structural Failure:   ${metrics.structural}%

================================================================================
📝 SEISMOLOGICAL ASSESSMENT REPORT (GEMINI AI)
================================================================================
${this.analysisReport || 'No AI analysis report available.'}

--------------------------------------------------------------------------------
Report generated on ${currentDate} via Remix: MCP Maps 3D
================================================================================
`;

    const blob = new Blob([reportContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    // Sanitize place name for file name
    const safePlace = place.replace(/[^a-z0-9]/gi, '_').replace(/_{2,}/g, '_').toLowerCase();
    link.href = url;
    link.download = `earthquake_analysis_report_M${magnitude.toFixed(1)}_${safePlace}.txt`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  render() {
    // Google Maps: Initial camera parameters for the <gmp-map-3d> element.
    const initialCenter = '0,0,100'; // lat,lng,altitude
    const initialRange = '20000000'; // View range in meters
    const initialTilt = '45'; // Camera tilt in degrees
    const initialHeading = '0'; // Camera heading in degrees

    return html`<div class="gdm-map-app">
      <div
        class="main-container"
        role="application"
        aria-label="Interactive Map Area">
        ${this.mapError
          ? html`<div
              class="map-error-message"
              role="alert"
              aria-live="assertive"
              >${this.mapError}</div
            >`
          : ''}
        <!-- Google Maps: The core 3D Map custom element -->
        <gmp-map-3d
          id="mapContainer"
          style="height: 100%; width: 100%;"
          aria-label="Google Photorealistic 3D Map Display"
          mode="hybrid"
          center="${initialCenter}"
          heading="${initialHeading}"
          tilt="${initialTilt}"
          range="${initialRange}"
          internal-usage-attribution-ids="gmp_aistudio_threedmapjsmcp_v0.1_showcase"
          default-ui-disabled="true"
          role="application">
        </gmp-map-3d>
      </div>
      <div class="sidebar" role="complementary" aria-labelledby="chat-heading">
        <div class="selector" role="tablist" aria-label="Chat providers">
          <button
            id="geminiTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.GEMINI}
            aria-controls="chat-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.GEMINI,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.GEMINI;
            }}>
            <span id="chat-heading">Gemini Chat</span>
          </button>
          <button
            id="earthquakesTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.EARTHQUAKES}
            aria-controls="earthquakes-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.EARTHQUAKES,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.EARTHQUAKES;
              if (this.earthquakes.length === 0) {
                this.fetchEarthquakes();
              }
            }}>
            <span>🌍 Live Earthquakes</span>
          </button>
        </div>
        <div
          id="chat-panel"
          role="tabpanel"
          aria-labelledby="geminiTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.GEMINI,
          })}>
          <div class="chat-messages" aria-live="polite" aria-atomic="false">
            ${this.messages}
            <div id="anchor"></div>
          </div>
          <div class="footer">
            <div
              id="chatStatus"
              aria-live="assertive"
              class=${classMap({'hidden': this.chatState === ChatState.IDLE})}>
              ${this.chatState === ChatState.GENERATING
                ? html`${ICON_BUSY} Generating...`
                : html``}
              ${this.chatState === ChatState.THINKING
                ? html`${ICON_BUSY} Thinking...`
                : html``}
              ${this.chatState === ChatState.EXECUTING
                ? html`${ICON_BUSY} Executing...`
                : html``}
            </div>
            <div
              id="inputArea"
              role="form"
              aria-labelledby="message-input-label">
              <label id="message-input-label" class="hidden"
                >Type your message</label
              >
              <input
                type="text"
                id="messageInput"
                .value=${this.inputMessage}
                @input=${(e: InputEvent) => {
                  this.inputMessage = (e.target as HTMLInputElement).value;
                }}
                @keydown=${(e: KeyboardEvent) => {
                  this.inputKeyDownAction(e);
                }}
                placeholder="Type your message..."
                autocomplete="off"
                aria-labelledby="message-input-label"
                aria-describedby="sendButton-desc" />
              <button
                id="sendButton"
                @click=${() => {
                  this.sendMessageAction();
                }}
                aria-label="Send message"
                aria-describedby="sendButton-desc"
                ?disabled=${this.chatState !== ChatState.IDLE}
                class=${classMap({
                  'disabled': this.chatState !== ChatState.IDLE,
                })}>
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="30px"
                  viewBox="0 -960 960 960"
                  width="30px"
                  fill="currentColor"
                  aria-hidden="true">
                  <path d="M120-160v-240l320-80-320-80v-240l760 320-760 320Z" />
                </svg>
              </button>
              <p id="sendButton-desc" class="hidden"
                >Sends the typed message to the AI.</p
              >
            </div>
          </div>
        </div>
        
        <div
          id="earthquakes-panel"
          role="tabpanel"
          aria-labelledby="earthquakesTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.EARTHQUAKES,
            'earthquakes-container': true,
          })}>
          
          <!-- Filter Timeframes bar -->
          <div class="eq-filter-header">
            <button 
              class="eq-filter-btn ${this.filterTimeframe === 'day' ? 'active' : ''}"
              @click=${() => this.fetchEarthquakes('day')}
              ?disabled=${this.earthquakesLoading}>
              M4.5+ (24h)
            </button>
            <button 
              class="eq-filter-btn ${this.filterTimeframe === 'week' ? 'active' : ''}"
              @click=${() => this.fetchEarthquakes('week')}
              ?disabled=${this.earthquakesLoading}>
              M4.5+ (7d)
            </button>
            <button 
              class="eq-filter-btn ${this.filterTimeframe === 'significant' ? 'active' : ''}"
              @click=${() => this.fetchEarthquakes('significant')}
              ?disabled=${this.earthquakesLoading}>
              Significant (7d)
            </button>
          </div>

          <!-- Statistics banner -->
          ${this.earthquakes.length > 0 ? html`
            <div class="eq-stats-bar">
              <div class="eq-stat-item">
                <span class="eq-stat-val">${this.earthquakes.length}</span>
                <span class="eq-stat-lbl">Events</span>
              </div>
              <div class="eq-stat-item">
                <span class="eq-stat-val">
                  M ${Math.max(...this.earthquakes.map(e => e.properties.mag || 0)).toFixed(1)}
                </span>
                <span class="eq-stat-lbl">Max Mag</span>
              </div>
              <div class="eq-stat-item">
                <span class="eq-stat-val">
                  ${this.earthquakes.filter(e => e.properties.tsunami === 1).length}
                </span>
                <span class="eq-stat-lbl">Tsunamis</span>
              </div>
            </div>
          ` : ''}

          <!-- Live list -->
          <div class="earthquake-list-scroller">
            ${this.earthquakesLoading ? html`
              <div class="eq-loading-placeholder">
                <div class="eq-shimmer-spinner"></div>
                <span>Retrieving live USGS feed...</span>
              </div>
            ` : this.earthquakes.length === 0 ? html`
              <div class="eq-empty-state">
                No heavy earthquakes detected in this timeframe. Tectonics are stable.
              </div>
            ` : this.earthquakes.map((eq) => {
              const mag = eq.properties.mag || 0.0;
              const place = eq.properties.place || 'Unknown Location';
              const date = new Date(eq.properties.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const depth = eq.geometry.coordinates[2] || 0;
              const hasTsunami = eq.properties.tsunami === 1;
              const isSelected = this.selectedEarthquake?.id === eq.id;

              // Color class based on magnitude
              let magColorClass = 'mag-amber';
              if (mag >= 6.0) {
                magColorClass = 'mag-red';
              } else if (mag >= 5.0) {
                magColorClass = 'mag-orange';
              }

              return html`
                <div 
                  class="earthquake-card ${isSelected ? 'active' : ''}"
                  @click=${() => this.selectEarthquake(eq)}>
                  <div class="eq-card-header">
                    <span class="eq-mag-badge ${magColorClass}">M ${mag.toFixed(1)}</span>
                    <span class="eq-time">${date}</span>
                  </div>
                  <div class="eq-place">${place}</div>
                  <div class="eq-meta">
                    <span>Depth: ${depth.toFixed(0)} km</span>
                    ${hasTsunami ? html`<span class="tsunami-warn-badge">🌊 TSUNAMI</span>` : ''}
                  </div>
                </div>
              `;
            })}
          </div>

          <!-- Selected Earthquake AI analysis -->
          ${this.selectedEarthquake ? html`
            <div class="eq-analysis-panel">
              <div class="eq-analysis-title-bar">
                <h3>🌋 Risk & Disaster Analysis</h3>
                <button class="eq-analysis-close" @click=${() => { this.selectedEarthquake = null; this.requestUpdate(); }}>✕</button>
              </div>

              <!-- Header meta of selected eq -->
              <div class="selected-eq-header">
                <div class="selected-eq-title">${this.selectedEarthquake.properties.place}</div>
                <div class="selected-eq-details">
                  <span>Magnitude: <strong>M ${this.selectedEarthquake.properties.mag?.toFixed(1)}</strong></span> |
                  <span>Depth: <strong>${this.selectedEarthquake.geometry.coordinates[2]?.toFixed(0)} km</strong></span> |
                  <span>Coordinates: <strong>${this.selectedEarthquake.geometry.coordinates[1]?.toFixed(3)}°, ${this.selectedEarthquake.geometry.coordinates[0]?.toFixed(3)}°</strong></span>
                </div>
              </div>

              <!-- Realtime Risk meters (heuristics) -->
              <div class="risk-meters-container">
                <h4>Dynamic Hazard Indicators</h4>
                <div class="risk-grid">
                  ${(() => {
                    const metrics = this.calculateHeuristicMetrics(this.selectedEarthquake);
                    return html`
                      <!-- Tsunami risk meter -->
                      <div class="risk-meter-item">
                        <div class="risk-meter-lbl">🌊 Tsunami Risk</div>
                        <div class="risk-progress-bg">
                          <div class="risk-progress-bar ${metrics.tsunami > 75 ? 'bg-danger' : metrics.tsunami > 40 ? 'bg-warning' : 'bg-success'}" style="width: ${metrics.tsunami}%"></div>
                        </div>
                        <div class="risk-meter-val">${metrics.tsunami}%</div>
                      </div>

                      <!-- Soil Liquefaction meter -->
                      <div class="risk-meter-item">
                        <div class="risk-meter-lbl">💧 Liquefaction Hazard</div>
                        <div class="risk-progress-bg">
                          <div class="risk-progress-bar ${metrics.liquefaction > 70 ? 'bg-danger' : metrics.liquefaction > 40 ? 'bg-warning' : 'bg-success'}" style="width: ${metrics.liquefaction}%"></div>
                        </div>
                        <div class="risk-meter-val">${metrics.liquefaction}%</div>
                      </div>

                      <!-- Landslide meter -->
                      <div class="risk-meter-item">
                        <div class="risk-meter-lbl">⛰️ Landslide Hazard</div>
                        <div class="risk-progress-bg">
                          <div class="risk-progress-bar ${metrics.landslide > 70 ? 'bg-danger' : metrics.landslide > 40 ? 'bg-warning' : 'bg-success'}" style="width: ${metrics.landslide}%"></div>
                        </div>
                        <div class="risk-meter-val">${metrics.landslide}%</div>
                      </div>

                      <!-- Structural collapse risk meter -->
                      <div class="risk-meter-item">
                        <div class="risk-meter-lbl">🏢 Structural Failure</div>
                        <div class="risk-progress-bg">
                          <div class="risk-progress-bar ${metrics.structural > 70 ? 'bg-danger' : metrics.structural > 40 ? 'bg-warning' : 'bg-success'}" style="width: ${metrics.structural}%"></div>
                        </div>
                        <div class="risk-meter-val">${metrics.structural}%</div>
                      </div>
                    `;
                  })()}
                </div>
              </div>

              <!-- Narrative report from Gemini -->
              <div class="narrative-analysis-box">
                <div class="narrative-header-row">
                  <h4>Seismological Assessment Report</h4>
                  ${this.analysisReport ? html`
                    <button class="download-report-btn" @click=${this.downloadReport} title="Download Assessment Report">
                      📥 Download Report
                    </button>
                  ` : ''}
                </div>
                ${this.analysisLoading && !this.analysisReport ? html`
                  <div class="shimmer-container">
                    <div class="shimmer-line"></div>
                    <div class="shimmer-line"></div>
                    <div class="shimmer-line"></div>
                  </div>
                ` : html`
                  <div class="narrative-text">
                    ${this.analysisReport ? this.renderMarkdown(this.analysisReport) : html`Requesting detailed scientific assessment from Gemini...`}
                  </div>
                `}
                ${this.analysisLoading && this.analysisReport ? html`<div class="narrative-typing-indicator">✍️ AI writing report...</div>` : ''}
              </div>
            </div>
          ` : html`
            <div class="eq-select-instruction">
              Select any earthquake from the list, or click on a 3D epicentral marker on the map to begin disaster risk analysis.
            </div>
          `}
        </div>
      </div>
    </div>`;
  }
}
