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
import {EarthquakeDB, SavedEarthquake} from './earthquake_db';

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
  DATABASE,
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

  // Local Database State
  @state() dbRecords: Record<string, SavedEarthquake[]> = {};
  @state() dbSearchQuery = '';

  // Compare Mode State
  @state() compareMode = false;
  @state() compareSelected: any[] = [];

  // Danger Zone & Video Recording State
  @state() showDangerZones = false;
  @state() isShockwaveAnimating = false;
  @state() shockwaveProgress = 0; // 0 to 100%
  @state() isRecordingVideo = false;
  @state() recordingCountdown = 0;
  @state() recordedVideoUrl: string | null = null;
  @state() showVideoModal = false;

  private dangerZonePolylines: any[] = [];
  private shockwavePolyline?: any;
  private shockwaveInterval?: any;
  private cameraOrbitInterval?: any;
  private mediaRecorder?: MediaRecorder;
  private recordedChunks: Blob[] = [];

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
    // Initialize DB records
    this.dbRecords = EarthquakeDB.getRecords();
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
    this.clearDangerZones();
    this.stopShockwaveAnimation();
    if (this.cameraOrbitInterval) {
      clearInterval(this.cameraOrbitInterval);
      this.cameraOrbitInterval = undefined;
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

        // Automatically ingest into the local top-5 daily database
        EarthquakeDB.addLiveEarthquakes(data.features);
        this.dbRecords = EarthquakeDB.getRecords();

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

    // Check if we already have a pre-saved report for this earthquake
    const eqId = eq.id || (eq.properties && String(eq.properties.time));
    const dateStr = this.getUtcDateStr(eq.properties && eq.properties.time);
    const savedDay = this.dbRecords[dateStr];
    const savedEq = savedDay ? savedDay.find(s => s.id === eqId) : null;

    if (savedEq && savedEq.report) {
      this.analysisReport = savedEq.report;
      this.analysisLoading = false;
      this.requestUpdate();
    } else {
      await this.runDisasterRiskAnalysis(eq);
    }
  }

  selectSavedEarthquake(saved: SavedEarthquake) {
    const eqFeature = {
      id: saved.id,
      type: 'Feature',
      properties: {
        mag: saved.mag,
        place: saved.place,
        time: saved.time,
        tsunami: saved.tsunami ? 1 : 0
      },
      geometry: {
        type: 'Point',
        coordinates: saved.coordinates
      }
    };
    
    // Plot all top-5 earthquakes from this day to make them visually present on the map
    const records = this.dbRecords;
    const dateStr = this.getUtcDateStr(saved.time);
    if (records[dateStr]) {
      this.earthquakes = records[dateStr].map(s => ({
        id: s.id,
        type: 'Feature',
        properties: {
          mag: s.mag,
          place: s.place,
          time: s.time,
          tsunami: s.tsunami ? 1 : 0
        },
        geometry: {
          type: 'Point',
          coordinates: s.coordinates
        }
      }));
      this.plotEarthquakesOnMap();
    }

    this.selectEarthquake(eqFeature);
  }

  private getUtcDateStr(time: number): string {
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  deleteSavedEarthquake(dateStr: string, id: string) {
    if (confirm('Are you sure you want to delete this earthquake from the database?')) {
      EarthquakeDB.deleteEarthquake(dateStr, id);
      this.dbRecords = EarthquakeDB.getRecords();
      this.requestUpdate();
    }
  }

  confirmClearDatabase() {
    if (confirm('Are you sure you want to clear the entire earthquake database? This cannot be undone.')) {
      EarthquakeDB.clearDatabase();
      this.dbRecords = EarthquakeDB.getRecords();
      this.requestUpdate();
    }
  }

  toggleCompareMode() {
    this.compareMode = !this.compareMode;
    if (!this.compareMode) {
      this.compareSelected = [];
    }
    this.requestUpdate();
  }

  toggleEarthquakeForComparison(rawEq: any) {
    const eq = this.normalizeToFeature(rawEq);
    if (!eq) return;

    const existingIdx = this.compareSelected.findIndex(item => item.id === eq.id);
    if (existingIdx > -1) {
      this.compareSelected = this.compareSelected.filter((_, idx) => idx !== existingIdx);
    } else {
      if (this.compareSelected.length >= 2) {
        // Replace second item
        this.compareSelected = [this.compareSelected[0], eq];
      } else {
        this.compareSelected = [...this.compareSelected, eq];
      }
    }

    if (this.compareSelected.length === 2) {
      this.highlightComparedEventsOnMap();
    }
    this.requestUpdate();
  }

  clearComparison() {
    this.compareSelected = [];
    this.requestUpdate();
  }

  isCompared(eqId: string): boolean {
    return this.compareSelected.some(item => item.id === eqId);
  }

  normalizeToFeature(eq: any): any {
    if (!eq) return null;
    if (eq.properties && eq.geometry) {
      return eq;
    }
    return {
      id: eq.id || String(eq.time),
      type: 'Feature',
      properties: {
        mag: eq.mag,
        place: eq.place,
        time: eq.time,
        tsunami: eq.tsunami ? 1 : 0,
        sig: Math.round((eq.mag || 4) * 100),
      },
      geometry: {
        type: 'Point',
        coordinates: eq.coordinates || [0, 0, 0]
      }
    };
  }

  calculateHaversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }

  calculateEnergyRatio(mag1: number, mag2: number): { ratioStr: string, text: string } {
    const diff = mag1 - mag2;
    const ratio = Math.pow(10, 1.5 * Math.abs(diff));
    let ratioFormatted = ratio >= 1000 ? ratio.toExponential(1) : ratio.toFixed(1);
    if (ratio < 1.05 && ratio > 0.95) {
      return { ratioStr: '1x', text: 'Both events released nearly identical seismic energy.' };
    }
    if (diff > 0) {
      return { ratioStr: `${ratioFormatted}x`, text: `Event A released ~${ratioFormatted}x more seismic energy than Event B.` };
    } else {
      return { ratioStr: `${ratioFormatted}x`, text: `Event B released ~${ratioFormatted}x more seismic energy than Event A.` };
    }
  }

  highlightComparedEventsOnMap() {
    if (this.compareSelected.length < 2 || !this.mapInitialized || !this.map) return;
    
    const eq1 = this.compareSelected[0];
    const eq2 = this.compareSelected[1];
    const c1 = eq1.geometry.coordinates;
    const c2 = eq2.geometry.coordinates;

    const lat1 = c1[1]; const lon1 = c1[0];
    const lat2 = c2[1]; const lon2 = c2[0];

    const midLat = (lat1 + lat2) / 2;
    const midLon = (lon1 + lon2) / 2;

    const distKm = this.calculateHaversineDistanceKm(lat1, lon1, lat2, lon2);
    const range = Math.max(3000000, Math.min(18000000, distKm * 3200));

    // Clear previous elements
    this._clearMapElements();

    // Draw line between them if Polyline3DElement is available
    if (this.Polyline3DElement) {
      try {
        const line = new this.Polyline3DElement();
        line.coordinates = [
          { lat: lat1, lng: lon1, altitude: 1000 },
          { lat: midLat, lng: midLon, altitude: Math.min(distKm * 200, 300000) },
          { lat: lat2, lng: lon2, altitude: 1000 }
        ];
        line.strokeColor = '#3b82f6';
        line.strokeWidth = 8;
        (this.map as any).appendChild(line);
        this.routePolyline = line;
      } catch (e) {
        console.warn('Could not draw polyline on 3D map:', e);
      }
    }

    (this.map as any).flyCameraTo({
      endCamera: {
        center: { lat: midLat, lng: midLon, altitude: 0 },
        heading: 0,
        tilt: 20,
        range: range,
      },
      durationMillis: 2500,
    });
  }

  askGeminiToCompare() {
    if (this.compareSelected.length < 2) return;
    const eq1 = this.compareSelected[0];
    const eq2 = this.compareSelected[1];

    const p1 = eq1.properties; const c1 = eq1.geometry.coordinates;
    const p2 = eq2.properties; const c2 = eq2.geometry.coordinates;

    const prompt = `Please provide a detailed seismological risk comparison between these two earthquake events:

1. **Event A**: M ${p1.mag?.toFixed(1)} - ${p1.place}
   - Depth: ${c1[2]} km
   - Coordinates: ${c1[1].toFixed(3)}°, ${c1[0].toFixed(3)}°
   - Tsunami Alert: ${p1.tsunami === 1 ? 'Yes' : 'No'}

2. **Event B**: M ${p2.mag?.toFixed(1)} - ${p2.place}
   - Depth: ${c2[2]} km
   - Coordinates: ${c2[1].toFixed(3)}°, ${c2[0].toFixed(3)}°
   - Tsunami Alert: ${p2.tsunami === 1 ? 'Yes' : 'No'}

Please compare:
- Relative energy release and shaking potential
- Epicentral setting (coastal/subduction zone vs inland fault)
- Tsunami, liquefaction, and structural risk differences
- Recommended disaster response priority`;

    this.selectedChatTab = ChatTab.GEMINI;
    this.sendMessageAction(prompt);
  }

  renderComparisonPanel() {
    if (!this.compareMode) return '';

    if (this.compareSelected.length === 0) {
      return html`
        <div class="compare-matrix-panel partial">
          <div class="compare-header-bar">
            <div class="compare-title">
              <h3>⚖️ Earthquake Comparison Matrix</h3>
              <p class="compare-subtitle">Select any 2 earthquakes from the list to compare risk parameters side-by-side.</p>
            </div>
            <button class="compare-close-btn" @click=${() => this.toggleCompareMode()}>✕ Close</button>
          </div>
        </div>
      `;
    }

    if (this.compareSelected.length === 1) {
      const eq1 = this.compareSelected[0];
      const p1 = eq1.properties || {};
      const c1 = (eq1.geometry && eq1.geometry.coordinates) || [0, 0, 0];

      return html`
        <div class="compare-matrix-panel partial">
          <div class="compare-header-bar">
            <div class="compare-title">
              <h3>⚖️ Earthquake Comparison Matrix (1/2 Selected)</h3>
              <p class="compare-subtitle">Click a 2nd earthquake to view side-by-side risk comparison.</p>
            </div>
            <div class="compare-actions">
              <button class="compare-action-btn" @click=${() => this.clearComparison()}>Clear</button>
              <button class="compare-close-btn" @click=${() => this.toggleCompareMode()}>✕</button>
            </div>
          </div>
          <div class="compare-cards-grid">
            <div class="compare-event-card">
              <div class="event-tag-bar">
                <span class="event-tag-badge">Event A</span>
                <span class="eq-mag-badge ${p1.mag >= 6 ? 'mag-red' : p1.mag >= 5 ? 'mag-orange' : 'mag-amber'}">
                  M ${p1.mag?.toFixed(1)}
                </span>
              </div>
              <div class="event-place">${p1.place}</div>
              <div class="event-meta-row">
                <span>Depth: ${c1[2]} km</span>
                <span>${p1.tsunami === 1 ? '🌊 Tsunami Alert' : 'No Tsunami'}</span>
              </div>
            </div>
            <div class="compare-event-card" style="border: 2px dashed var(--color-sidebar-border); display: flex; align-items: center; justify-content: center; text-align: center;">
              <span class="compare-subtitle">+ Click 2nd event to compare</span>
            </div>
          </div>
        </div>
      `;
    }

    // 2 events selected
    const eq1 = this.compareSelected[0];
    const p1 = eq1.properties || {};
    const c1 = (eq1.geometry && eq1.geometry.coordinates) || [0, 0, 0];

    const eq2 = this.compareSelected[1];
    const p2 = eq2.properties || {};
    const c2 = (eq2.geometry && eq2.geometry.coordinates) || [0, 0, 0];

    const mag1 = p1.mag || 0;
    const mag2 = p2.mag || 0;
    const depth1 = c1[2] || 0;
    const depth2 = c2[2] || 0;

    const distKm = this.calculateHaversineDistanceKm(c1[1], c1[0], c2[1], c2[0]);
    const energy = this.calculateEnergyRatio(mag1, mag2);

    // Max values for bars
    const maxMag = Math.max(mag1, mag2, 8.0);
    const mag1Pct = Math.min(100, (mag1 / maxMag) * 100);
    const mag2Pct = Math.min(100, (mag2 / maxMag) * 100);

    const maxDepth = Math.max(depth1, depth2, 100);
    const depth1Pct = Math.min(100, (depth1 / maxDepth) * 100);
    const depth2Pct = Math.min(100, (depth2 / maxDepth) * 100);

    return html`
      <div class="compare-matrix-panel">
        <div class="compare-header-bar">
          <div class="compare-title">
            <h3>⚖️ Side-by-Side Comparison</h3>
            <p class="compare-subtitle">Distance between epicenters: <strong>${distKm.toLocaleString()} km</strong></p>
          </div>
          <div class="compare-actions">
            <button class="compare-action-btn primary" @click=${() => this.askGeminiToCompare()}>
              ✨ AI Risk Analysis
            </button>
            <button class="compare-action-btn" @click=${() => this.clearComparison()}>
              Reset
            </button>
            <button class="compare-close-btn" @click=${() => this.toggleCompareMode()} title="Exit Compare Mode">
              ✕
            </button>
          </div>
        </div>

        <div class="compare-summary-bar">
          <div class="summary-pill">
            <span class="summary-lbl">Energy Difference</span>
            <span class="summary-val">${energy.ratioStr}</span>
          </div>
          <div class="summary-desc">
            ${energy.text}
          </div>
        </div>

        <div class="compare-cards-grid">
          <div class="compare-event-card">
            <div class="event-tag-bar">
              <span class="event-tag-badge">Event A</span>
              <span class="eq-mag-badge ${mag1 >= 6 ? 'mag-red' : mag1 >= 5 ? 'mag-orange' : 'mag-amber'}">
                M ${mag1.toFixed(1)}
              </span>
            </div>
            <div class="event-place">${p1.place}</div>
            <div class="event-meta-row">
              <span>Depth: ${depth1} km</span>
              ${p1.tsunami === 1 ? html`<span style="color: #ef4444; font-weight: bold;">🌊 Tsunami</span>` : ''}
            </div>
          </div>

          <div class="compare-event-card">
            <div class="event-tag-bar">
              <span class="event-tag-badge">Event B</span>
              <span class="eq-mag-badge ${mag2 >= 6 ? 'mag-red' : mag2 >= 5 ? 'mag-orange' : 'mag-amber'}">
                M ${mag2.toFixed(1)}
              </span>
            </div>
            <div class="event-place">${p2.place}</div>
            <div class="event-meta-row">
              <span>Depth: ${depth2} km</span>
              ${p2.tsunami === 1 ? html`<span style="color: #ef4444; font-weight: bold;">🌊 Tsunami</span>` : ''}
            </div>
          </div>
        </div>

        <div class="compare-metrics-section">
          <div class="compare-metrics-title">
            <span>Risk Parameter Visualizer</span>
            <div class="compare-vs-header">
              <span>Event A</span>
              <span class="vs-badge">VS</span>
              <span>Event B</span>
            </div>
          </div>

          <!-- Magnitude Metric Row -->
          <div class="compare-metric-row">
            <div class="metric-row-label">Magnitude (M)</div>
            <div class="metric-dual-bars">
              <div class="metric-bar-wrapper left">
                <span class="metric-bar-val">${mag1.toFixed(1)}</span>
                <div class="metric-bar-bg">
                  <div class="metric-bar-fill" style="width: ${mag1Pct}%; background-color: ${mag1 >= 6 ? '#ef4444' : mag1 >= 5 ? '#f97316' : '#f59e0b'};"></div>
                </div>
              </div>
              <div class="metric-bar-separator"></div>
              <div class="metric-bar-wrapper right">
                <div class="metric-bar-bg">
                  <div class="metric-bar-fill" style="width: ${mag2Pct}%; background-color: ${mag2 >= 6 ? '#ef4444' : mag2 >= 5 ? '#f97316' : '#f59e0b'};"></div>
                </div>
                <span class="metric-bar-val">${mag2.toFixed(1)}</span>
              </div>
            </div>
          </div>

          <!-- Depth Metric Row -->
          <div class="compare-metric-row">
            <div class="metric-row-label">Focal Depth (km - Shallow = Higher Surface Shaking)</div>
            <div class="metric-dual-bars">
              <div class="metric-bar-wrapper left">
                <span class="metric-bar-val">${depth1} km</span>
                <div class="metric-bar-bg">
                  <div class="metric-bar-fill" style="width: ${depth1Pct}%; background-color: ${depth1 < 30 ? '#ef4444' : '#3b82f6'};"></div>
                </div>
              </div>
              <div class="metric-bar-separator"></div>
              <div class="metric-bar-wrapper right">
                <div class="metric-bar-bg">
                  <div class="metric-bar-fill" style="width: ${depth2Pct}%; background-color: ${depth2 < 30 ? '#ef4444' : '#3b82f6'};"></div>
                </div>
                <span class="metric-bar-val">${depth2} km</span>
              </div>
            </div>
          </div>

          <!-- Tsunami Hazard Row -->
          <div class="compare-metric-row">
            <div class="metric-row-label">Tsunami Risk & Warning Status</div>
            <div class="metric-dual-bars" style="justify-content: space-between;">
              <span class="metric-bar-val" style="color: ${p1.tsunami === 1 ? '#ef4444' : 'var(--color-text)'}">
                ${p1.tsunami === 1 ? '⚠️ Active Warning (1)' : 'None (0)'}
              </span>
              <span class="vs-badge">VS</span>
              <span class="metric-bar-val" style="color: ${p2.tsunami === 1 ? '#ef4444' : 'var(--color-text)'}">
                ${p2.tsunami === 1 ? '⚠️ Active Warning (1)' : 'None (0)'}
              </span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  generateCircle3DCoordinates(centerLat: number, centerLng: number, radiusKm: number, altitude = 50, numPoints = 64) {
    const points = [];
    const R = 6371; // Earth radius in km
    const latRad = centerLat * (Math.PI / 180);
    const lngRad = centerLng * (Math.PI / 180);
    const d = radiusKm / R;

    for (let i = 0; i <= numPoints; i++) {
      const bearing = (i * 360 / numPoints) * (Math.PI / 180);
      const pointLatRad = Math.asin(
        Math.sin(latRad) * Math.cos(d) +
        Math.cos(latRad) * Math.sin(d) * Math.cos(bearing)
      );
      const pointLngRad = lngRad + Math.atan2(
        Math.sin(bearing) * Math.sin(d) * Math.cos(latRad),
        Math.cos(d) - Math.sin(latRad) * Math.sin(pointLatRad)
      );
      points.push({
        lat: pointLatRad * (180 / Math.PI),
        lng: pointLngRad * (180 / Math.PI),
        altitude: altitude
      });
    }
    return points;
  }

  renderDangerZonesOnMap(eq: any) {
    this.clearDangerZones();
    if (!this.map || !this.Polyline3DElement || !eq) return;

    const coords = eq.geometry ? eq.geometry.coordinates : eq.coordinates;
    if (!coords) return;
    const lat = coords[1];
    const lng = coords[0];
    const mag = (eq.properties ? eq.properties.mag : eq.mag) || 5.0;
    const depth = Math.max(1, coords[2] || 10);
    const depthFactor = Math.sqrt(depth / 10);

    const rSevere = Math.max(8, Math.round((mag - 4.5) * 40 / depthFactor));
    const rModerate = Math.max(25, Math.round((mag - 3.5) * 80 / depthFactor));
    const rLight = Math.max(60, Math.round(mag * 70));
    const hasTsunami = (eq.properties ? eq.properties.tsunami === 1 : eq.tsunami);
    const rTsunami = hasTsunami ? Math.max(80, Math.round(mag * 90)) : 0;

    const zones = [
      { radius: rLight, color: '#f59e0b', width: 4, alt: 200 },
      { radius: rModerate, color: '#f97316', width: 5, alt: 400 },
      { radius: rSevere, color: '#ef4444', width: 7, alt: 800 },
    ];
    if (hasTsunami) {
      zones.push({ radius: rTsunami, color: '#06b6d4', width: 6, alt: 600 });
    }

    for (const z of zones) {
      try {
        const circlePts = this.generateCircle3DCoordinates(lat, lng, z.radius, z.alt);
        const line = new this.Polyline3DElement();
        line.coordinates = circlePts;
        line.strokeColor = z.color;
        line.strokeWidth = z.width;
        (this.map as any).appendChild(line);
        this.dangerZonePolylines.push(line);
      } catch (e) {
        console.warn('Error rendering danger zone ring:', e);
      }
    }

    this.showDangerZones = true;
    this.requestUpdate();
  }

  clearDangerZones() {
    if (this.dangerZonePolylines && this.dangerZonePolylines.length > 0) {
      for (const poly of this.dangerZonePolylines) {
        try { poly.remove(); } catch (e) {}
      }
      this.dangerZonePolylines = [];
    }
    if (this.shockwavePolyline) {
      try { this.shockwavePolyline.remove(); } catch (e) {}
      this.shockwavePolyline = undefined;
    }
    this.showDangerZones = false;
    this.requestUpdate();
  }

  toggleDangerZones(eq: any) {
    if (this.showDangerZones) {
      this.clearDangerZones();
    } else {
      this.renderDangerZonesOnMap(eq);
    }
  }

  startShockwaveAnimation(eq: any) {
    this.stopShockwaveAnimation();
    if (!this.map || !this.Polyline3DElement || !eq) return;

    const coords = eq.geometry ? eq.geometry.coordinates : eq.coordinates;
    if (!coords) return;
    const lat = coords[1];
    const lng = coords[0];
    const mag = (eq.properties ? eq.properties.mag : eq.mag) || 5.0;
    const maxRadius = Math.max(50, Math.round(mag * 85));

    this.isShockwaveAnimating = true;
    this.shockwaveProgress = 0;

    this.shockwaveInterval = setInterval(() => {
      this.shockwaveProgress = (this.shockwaveProgress + 3) % 100;
      const currentRadius = Math.max(1, (this.shockwaveProgress / 100) * maxRadius);

      if (this.shockwavePolyline) {
        try { this.shockwavePolyline.remove(); } catch (e) {}
      }

      try {
        const circlePts = this.generateCircle3DCoordinates(lat, lng, currentRadius, 1000);
        const line = new this.Polyline3DElement();
        line.coordinates = circlePts;
        line.strokeColor = '#ff2222';
        line.strokeWidth = 10;
        (this.map as any).appendChild(line);
        this.shockwavePolyline = line;
      } catch (e) {
        console.warn('Shockwave line error:', e);
      }
      this.requestUpdate();
    }, 60);
  }

  stopShockwaveAnimation() {
    if (this.shockwaveInterval) {
      clearInterval(this.shockwaveInterval);
      this.shockwaveInterval = undefined;
    }
    if (this.shockwavePolyline) {
      try { this.shockwavePolyline.remove(); } catch (e) {}
      this.shockwavePolyline = undefined;
    }
    this.isShockwaveAnimating = false;
    this.requestUpdate();
  }

  trigger3DFlyoverOrbit(eq: any) {
    if (!this.map || !eq) return;
    const coords = eq.geometry ? eq.geometry.coordinates : eq.coordinates;
    if (!coords) return;
    const lat = coords[1];
    const lng = coords[0];

    let currentHeading = 0;
    if (this.cameraOrbitInterval) {
      clearInterval(this.cameraOrbitInterval);
    }

    this.cameraOrbitInterval = setInterval(() => {
      currentHeading = (currentHeading + 10) % 360;
      try {
        (this.map as any).flyCameraTo({
          endCamera: {
            center: { lat: lat, lng: lng, altitude: 0 },
            heading: currentHeading,
            tilt: 55,
            range: 150000,
          },
          durationMillis: 800,
        });
      } catch (e) {}
    }, 800);

    setTimeout(() => {
      if (this.cameraOrbitInterval) {
        clearInterval(this.cameraOrbitInterval);
        this.cameraOrbitInterval = undefined;
      }
    }, 10000);
  }

  findMapCanvas(): HTMLCanvasElement | null {
    if (this.mapContainerElement) {
      let canvas = this.mapContainerElement.querySelector('canvas');
      if (canvas) return canvas;
      if (this.mapContainerElement.shadowRoot) {
        canvas = this.mapContainerElement.shadowRoot.querySelector('canvas');
        if (canvas) return canvas;
      }
    }
    const allCanvases = Array.from(document.querySelectorAll('canvas'));
    return allCanvases[0] || null;
  }

  async startDangerVideoRecording(eq: any) {
    if (!eq) return;
    this.clearDangerZones();
    this.renderDangerZonesOnMap(eq);
    this.startShockwaveAnimation(eq);
    this.trigger3DFlyoverOrbit(eq);

    this.isRecordingVideo = true;
    this.recordingCountdown = 6;
    this.recordedVideoUrl = null;
    this.recordedChunks = [];

    const canvas = this.findMapCanvas();
    let stream: MediaStream | null = null;

    if (canvas && typeof (canvas as any).captureStream === 'function') {
      try {
        stream = (canvas as any).captureStream(30);
      } catch (e) {
        console.warn('Canvas captureStream error:', e);
      }
    }

    if (stream && typeof MediaRecorder !== 'undefined') {
      try {
        let mimeType = 'video/webm';
        if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
          mimeType = 'video/webm;codecs=vp9';
        } else if (MediaRecorder.isTypeSupported('video/mp4')) {
          mimeType = 'video/mp4';
        }

        this.mediaRecorder = new MediaRecorder(stream, { mimeType });
        this.mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            this.recordedChunks.push(event.data);
          }
        };

        this.mediaRecorder.onstop = () => {
          const blob = new Blob(this.recordedChunks, { type: mimeType });
          this.recordedVideoUrl = URL.createObjectURL(blob);
          this.isRecordingVideo = false;
          this.showVideoModal = true;
          this.stopShockwaveAnimation();
          this.requestUpdate();
        };

        this.mediaRecorder.start();
      } catch (e) {
        console.warn('MediaRecorder error:', e);
        this.fallbackVideoRecordingSim();
      }
    } else {
      this.fallbackVideoRecordingSim();
    }

    const timer = setInterval(() => {
      this.recordingCountdown -= 1;
      if (this.recordingCountdown <= 0) {
        clearInterval(timer);
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
          this.mediaRecorder.stop();
        } else {
          this.finishSimulatedVideoRecording();
        }
      }
      this.requestUpdate();
    }, 1000);
  }

  fallbackVideoRecordingSim() {
    console.log('Using animated WebGL canvas simulation for video capture.');
  }

  finishSimulatedVideoRecording() {
    this.isRecordingVideo = false;
    this.showVideoModal = true;
    this.stopShockwaveAnimation();
    this.requestUpdate();
  }

  renderDangerVisualizerCard(eq: any) {
    if (!eq) return '';

    return html`
      <div class="danger-visualizer-card">
        <div class="danger-card-header">
          <div class="danger-card-title">
            <h4>🌊 3D Danger & Shockwave Visualizer</h4>
            <p class="danger-card-sub">Render MMI shaking hazard rings & export 3D danger video</p>
          </div>
          ${this.isRecordingVideo ? html`
            <span class="recording-pill-live">
              🔴 RECORDING VIDEO (${this.recordingCountdown}s)
            </span>
          ` : ''}
        </div>

        <div class="danger-toolbar-actions">
          <button 
            class="danger-btn ${this.showDangerZones ? 'active' : ''}" 
            @click=${() => this.toggleDangerZones(eq)}>
            ${this.showDangerZones ? '⭕ Hide Hazard Rings' : '⭕ Draw Hazard Rings'}
          </button>

          <button 
            class="danger-btn ${this.isShockwaveAnimating ? 'active' : ''}" 
            @click=${() => this.isShockwaveAnimating ? this.stopShockwaveAnimation() : this.startShockwaveAnimation(eq)}>
            ${this.isShockwaveAnimating ? '⏸️ Stop Wave' : '⚡ Animate Wave'}
          </button>

          <button 
            class="danger-btn primary-record" 
            ?disabled=${this.isRecordingVideo}
            @click=${() => this.startDangerVideoRecording(eq)}>
            🎥 Record & Export Video
          </button>

          <button 
            class="danger-btn" 
            @click=${() => this.trigger3DFlyoverOrbit(eq)}>
            🚁 3D Orbit
          </button>
        </div>

        ${this.showDangerZones || this.isShockwaveAnimating ? html`
          <div class="danger-zone-legend">
            <div class="legend-item"><span class="dot red"></span> Heavy Shaking (MMI VIII+)</div>
            <div class="legend-item"><span class="dot orange"></span> Moderate Shaking (MMI VI-VII)</div>
            <div class="legend-item"><span class="dot yellow"></span> Light Shaking (MMI IV-V)</div>
            ${(eq.properties ? eq.properties.tsunami === 1 : eq.tsunami) ? html`
              <div class="legend-item"><span class="dot cyan"></span> Tsunami Hazard Buffer</div>
            ` : ''}
          </div>
        ` : ''}

        ${this.recordedVideoUrl ? html`
          <div class="recorded-video-banner">
            <div class="video-info">
              <span>🎬 <strong>Danger Video Ready!</strong></span>
            </div>
            <div class="video-buttons">
              <button class="v-btn play" @click=${() => { this.showVideoModal = true; this.requestUpdate(); }}>
                ▶️ Preview
              </button>
              <a class="v-btn download" href=${this.recordedVideoUrl} download="earthquake-danger-simulation-${eq.id || 'event'}.webm">
                📥 Download .WebM
              </a>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  renderVideoModal() {
    if (!this.showVideoModal) return '';

    const eq = this.selectedEarthquake;
    const mag = eq?.properties?.mag?.toFixed(1) || '?.?';
    const place = eq?.properties?.place || 'Earthquake Center';

    return html`
      <div class="video-modal-backdrop" @click=${() => { this.showVideoModal = false; this.requestUpdate(); }}>
        <div class="video-modal-content" @click=${(e: Event) => e.stopPropagation()}>
          <div class="video-modal-header">
            <h3>📹 3D Seismological Danger Video Simulation</h3>
            <button class="modal-close-btn" @click=${() => { this.showVideoModal = false; this.requestUpdate(); }}>✕</button>
          </div>
          <div class="video-modal-body">
            ${this.recordedVideoUrl ? html`
              <video src=${this.recordedVideoUrl} controls autoplay loop class="recorded-video-player"></video>
            ` : html`
              <div class="simulated-video-player">
                <div class="simulated-pulse-ring"></div>
                <div class="simulated-telemetry">
                  <div class="sim-title">LOCATION: ${place}</div>
                  <div class="sim-meta">MAGNITUDE: M${mag} | SHOCKWAVE PROPAGATION RECORDING</div>
                </div>
              </div>
            `}
          </div>
          <div class="video-modal-footer">
            ${this.recordedVideoUrl ? html`
              <a class="v-btn download primary" href=${this.recordedVideoUrl} download="earthquake-danger-video-${eq?.id || 'sim'}.webm">
                📥 Download .WebM Video
              </a>
            ` : ''}
            <button class="v-btn" @click=${() => { this.showVideoModal = false; this.requestUpdate(); }}>
              Close Preview
            </button>
          </div>
        </div>
      </div>
    `;
  }

  async _handleAnalyzeEarthquakeQuery(queryStr: string) {
    if (this.earthquakes.length === 0) {
      await this.fetchEarthquakes('week');
    }

    const lowerQuery = queryStr.toLowerCase().trim();
    let match = null;

    if (
      lowerQuery === 'latest' ||
      lowerQuery === 'most recent' ||
      lowerQuery === 'recent' ||
      lowerQuery === 'newest' ||
      lowerQuery === 'last' ||
      lowerQuery.includes('latest earthquake') ||
      lowerQuery.includes('most recent earthquake')
    ) {
      if (this.earthquakes.length > 0) {
        match = this.earthquakes.reduce((latest: any, current: any) => 
          (current.properties.time > latest.properties.time) ? current : latest
        , this.earthquakes[0]);
      }
    }

    if (!match) {
      match = this.earthquakes.find((eq) => 
        eq.properties.place.toLowerCase().includes(lowerQuery)
      );
    }

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
        model: 'gemini-3.6-flash',
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

      // Save the report to the local database automatically
      if (this.analysisReport && !this.analysisReport.startsWith('An error occurred')) {
        EarthquakeDB.saveReport(eq, this.analysisReport);
        this.dbRecords = EarthquakeDB.getRecords();
      }
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
          <button
            id="databaseTab"
            role="tab"
            aria-selected=${this.selectedChatTab === ChatTab.DATABASE}
            aria-controls="database-panel"
            class=${classMap({
              'selected-tab': this.selectedChatTab === ChatTab.DATABASE,
            })}
            @click=${() => {
              this.selectedChatTab = ChatTab.DATABASE;
              this.dbRecords = EarthquakeDB.getRecords();
            }}>
            <span>📁 Saved DB</span>
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
            <button 
              class="eq-compare-toggle-btn ${this.compareMode ? 'active' : ''}"
              @click=${() => this.toggleCompareMode()}>
              ⚖️ Compare ${this.compareSelected.length > 0 ? `(${this.compareSelected.length}/2)` : ''}
            </button>
          </div>

          <!-- Compare Mode Instruction Banner -->
          ${this.compareMode ? html`
            <div class="compare-instruction-banner">
              <span>⚖️ <strong>Compare Mode Active:</strong> Click any 2 earthquakes to compare side-by-side</span>
              ${this.compareSelected.length > 0 ? html`
                <button class="compare-clear-btn" @click=${() => this.clearComparison()}>Clear (${this.compareSelected.length})</button>
              ` : ''}
            </div>
          ` : ''}

          <!-- Statistics banner -->
          ${this.earthquakes.length > 0 && !this.compareMode ? html`
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

          <!-- Side-by-Side Comparison Matrix Panel -->
          ${this.renderComparisonPanel()}

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
              const isCompared = this.isCompared(eq.id);

              // Color class based on magnitude
              let magColorClass = 'mag-amber';
              if (mag >= 6.0) {
                magColorClass = 'mag-red';
              } else if (mag >= 5.0) {
                magColorClass = 'mag-orange';
              }

              return html`
                <div 
                  class="earthquake-card ${isSelected ? 'active' : ''} ${isCompared ? 'compare-selected' : ''}"
                  @click=${() => {
                    if (this.compareMode) {
                      this.toggleEarthquakeForComparison(eq);
                    } else {
                      this.selectEarthquake(eq);
                    }
                  }}>
                  <div class="eq-card-header">
                    <div style="display: flex; gap: 6px; align-items: center;">
                      ${this.compareMode ? html`
                        <span class="compare-check-pill ${isCompared ? 'checked' : ''}">
                          ${isCompared ? '✓ Selected' : '+ Compare'}
                        </span>
                      ` : ''}
                      <span class="eq-mag-badge ${magColorClass}">M ${mag.toFixed(1)}</span>
                    </div>
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
          ${this.selectedEarthquake && !this.compareMode ? html`
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

              <!-- 3D Danger & Shockwave Visualizer Card -->
              ${this.renderDangerVisualizerCard(this.selectedEarthquake)}

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

        <div
          id="database-panel"
          role="tabpanel"
          aria-labelledby="databaseTab"
          class=${classMap({
            'tabcontent': true,
            'showtab': this.selectedChatTab === ChatTab.DATABASE,
            'database-container': true,
          })}>
          
          <div class="db-header">
            <h3>📁 Saved Top-5 Daily Earthquakes</h3>
            <p class="db-subtitle">Durable local archive of the day's heaviest seismic events.</p>
          </div>

          <div class="db-toolbar">
            <div class="db-search-box">
              <input 
                type="text" 
                placeholder="Search location or date (YYYY-MM-DD)..." 
                .value=${this.dbSearchQuery}
                @input=${(e: InputEvent) => { this.dbSearchQuery = (e.target as HTMLInputElement).value; }} />
              ${this.dbSearchQuery ? html`
                <button class="db-search-clear" @click=${() => { this.dbSearchQuery = ''; }}>✕</button>
              ` : ''}
            </div>
            <button 
              class="eq-compare-toggle-btn ${this.compareMode ? 'active' : ''}"
              @click=${() => this.toggleCompareMode()}>
              ⚖️ Compare ${this.compareSelected.length > 0 ? `(${this.compareSelected.length}/2)` : ''}
            </button>
            ${Object.keys(this.dbRecords).length > 0 ? html`
              <button class="db-clear-all-btn" @click=${this.confirmClearDatabase}>
                🧹 Clear
              </button>
            ` : ''}
          </div>

          <!-- Compare Mode Instruction Banner -->
          ${this.compareMode ? html`
            <div class="compare-instruction-banner">
              <span>⚖️ <strong>Compare Mode Active:</strong> Click any 2 saved events to compare side-by-side</span>
              ${this.compareSelected.length > 0 ? html`
                <button class="compare-clear-btn" @click=${() => this.clearComparison()}>Clear (${this.compareSelected.length})</button>
              ` : ''}
            </div>
          ` : ''}

          <!-- Side-by-Side Comparison Matrix Panel -->
          ${this.renderComparisonPanel()}

          <!-- DB Records List -->
          <div class="database-list-scroller">
            ${(() => {
              const records = this.dbRecords;
              const dates = Object.keys(records).sort((a, b) => b.localeCompare(a));
              const query = this.dbSearchQuery.toLowerCase().trim();

              // Filter records
              const filteredDates = dates.filter(dateStr => {
                if (!query) return true;
                if (dateStr.includes(query)) return true;
                const eqs = records[dateStr];
                return eqs.some(eq => eq.place.toLowerCase().includes(query));
              });

              if (dates.length === 0) {
                return html`
                  <div class="db-empty-state">
                    <div class="db-empty-icon">📁</div>
                    <div class="db-empty-title">Database is empty</div>
                    <p>Fetch live earthquakes using the <strong>Live Earthquakes</strong> tab or ask Gemini, and the top 5 of each day will automatically save here.</p>
                  </div>
                `;
              }

              if (filteredDates.length === 0) {
                return html`
                  <div class="db-empty-state">
                    No matching records found for "${this.dbSearchQuery}".
                  </div>
                `;
              }

              return filteredDates.map(dateStr => {
                const eqs = records[dateStr].filter(eq => {
                  if (!query) return true;
                  return dateStr.includes(query) || eq.place.toLowerCase().includes(query);
                });

                if (eqs.length === 0) return '';

                // Format friendly date
                let friendlyDate = dateStr;
                try {
                  const d = new Date(dateStr + 'T00:00:00Z');
                  friendlyDate = d.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
                } catch(e){}

                return html`
                  <div class="db-day-group">
                    <div class="db-day-header">
                      <span class="db-day-date">📅 ${friendlyDate}</span>
                      <span class="db-day-count">${eqs.length} Saved</span>
                    </div>
                    <div class="db-day-cards">
                      ${eqs.map(eq => {
                        const mag = eq.mag;
                        let magColorClass = 'mag-amber';
                        if (mag >= 6.0) {
                          magColorClass = 'mag-red';
                        } else if (mag >= 5.0) {
                          magColorClass = 'mag-orange';
                        }

                        const timeStr = new Date(eq.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                        const depth = eq.coordinates[2] || 0;
                        const isCompared = this.isCompared(eq.id);

                        return html`
                          <div 
                            class="db-eq-card ${isCompared ? 'compare-selected' : ''}" 
                            @click=${() => {
                              if (this.compareMode) {
                                this.toggleEarthquakeForComparison(eq);
                              } else {
                                this.selectSavedEarthquake(eq);
                              }
                            }}>
                            <div class="db-eq-info">
                              <div class="db-eq-meta">
                                ${this.compareMode ? html`
                                  <span class="compare-check-pill ${isCompared ? 'checked' : ''}">
                                    ${isCompared ? '✓ Selected' : '+ Compare'}
                                  </span>
                                ` : ''}
                                <span class="db-eq-mag ${magColorClass}">M ${mag.toFixed(1)}</span>
                                <span class="db-eq-time">${timeStr} UTC</span>
                                ${eq.report ? html`<span class="db-eq-report-badge" title="AI Seismological Report is saved offline">📝 Report</span>` : ''}
                              </div>
                              <div class="db-eq-place">${eq.place}</div>
                              <div class="db-eq-depth">Depth: ${depth.toFixed(0)} km</div>
                            </div>
                            <div class="db-eq-actions">
                              <button 
                                class="db-eq-delete-btn" 
                                @click=${(e: Event) => { e.stopPropagation(); this.deleteSavedEarthquake(dateStr, eq.id); }} 
                                title="Delete from Database">
                                🗑️
                              </button>
                            </div>
                          </div>
                        `;
                      })}
                    </div>
                  </div>
                `;
              });
            })()}
          </div>
        </div>
      </div>
      ${this.renderVideoModal()}
    </div>`;
  }
}
