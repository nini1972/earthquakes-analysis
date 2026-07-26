export interface SavedEarthquake {
  id: string;
  mag: number;
  place: string;
  time: number;
  tsunami: boolean;
  coordinates: [number, number, number]; // [longitude, latitude, depth]
  report?: string; // Saved Gemini Seismological report
  shakeMapPga?: number;
  pagerLevel?: string;
  elevationMeters?: number;
  aftershockCount?: number;
}

export class EarthquakeDB {
  private static STORAGE_KEY = 'earthquakes_daily_top5';

  /**
   * Retrieves all records from the simple database.
   */
  static getRecords(): Record<string, SavedEarthquake[]> {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return {};
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      console.error('Failed to read from earthquake database:', e);
      return {};
    }
  }

  /**
   * Saves records to localStorage.
   */
  static saveRecords(records: Record<string, SavedEarthquake[]>) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(records));
    } catch (e) {
      console.error('Failed to write to earthquake database:', e);
    }
  }

  /**
   * Processes a list of live earthquake features and maintains the top 5 for each day.
   */
  static addLiveEarthquakes(features: any[]): { addedCount: number; updatedDays: string[] } {
    if (!Array.isArray(features)) {
      return { addedCount: 0, updatedDays: [] };
    }

    const records = this.getRecords();
    const updatedDaysSet = new Set<string>();
    let addedCount = 0;

    for (const f of features) {
      if (!f.properties || !f.geometry || !f.geometry.coordinates) continue;

      const id = f.id || String(f.properties.time);
      const mag = typeof f.properties.mag === 'number' ? f.properties.mag : 0;
      const place = f.properties.place || 'Unknown Location';
      const time = typeof f.properties.time === 'number' ? f.properties.time : Date.now();
      const tsunami = f.properties.tsunami === 1;
      const coordinates = f.geometry.coordinates as [number, number, number];

      // Format date to UTC date string YYYY-MM-DD
      const date = new Date(time);
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      if (!records[dateStr]) {
        records[dateStr] = [];
      }

      // Check if already exists in this day
      const existingIdx = records[dateStr].findIndex(eq => eq.id === id);
      const newEq: SavedEarthquake = { id, mag, place, time, tsunami, coordinates };

      if (existingIdx > -1) {
        // Keep the updated info, preserving any existing report
        const existingReport = records[dateStr][existingIdx].report;
        records[dateStr][existingIdx] = {
          ...newEq,
          report: existingReport || newEq.report
        };
      } else {
        records[dateStr].push(newEq);
        addedCount++;
      }
      updatedDaysSet.add(dateStr);
    }

    // For all updated days, preserve all records with saved reports, plus top live events
    for (const dateStr of updatedDaysSet) {
      const withReports = records[dateStr].filter(eq => !!eq.report);
      const withoutReports = records[dateStr].filter(eq => !eq.report);
      withoutReports.sort((a, b) => b.mag - a.mag);
      
      const maxWithoutReports = Math.max(0, 5 - withReports.length);
      const keptWithoutReports = withoutReports.slice(0, Math.max(maxWithoutReports, 5));
      
      const combinedMap = new Map<string, SavedEarthquake>();
      for (const item of [...withReports, ...keptWithoutReports]) {
        combinedMap.set(item.id, item);
      }
      
      const combinedList = Array.from(combinedMap.values());
      combinedList.sort((a, b) => b.mag - a.mag);
      records[dateStr] = combinedList;
    }

    this.saveRecords(records);
    return {
      addedCount,
      updatedDays: Array.from(updatedDaysSet)
    };
  }

  /**
   * Saves or updates a report for a specific earthquake.
   * If it doesn't exist, we add it to that day's list.
   */
  static saveReport(eqFeature: any, report: string, extraData?: Partial<SavedEarthquake>): boolean {
    if (!eqFeature || !eqFeature.properties) return false;
    
    const records = this.getRecords();
    const id = eqFeature.id || String(eqFeature.properties.time);
    const mag = typeof eqFeature.properties.mag === 'number' ? eqFeature.properties.mag : 0;
    const place = eqFeature.properties.place || 'Unknown Location';
    const time = typeof eqFeature.properties.time === 'number' ? eqFeature.properties.time : Date.now();
    const tsunami = eqFeature.properties.tsunami === 1;
    const coordinates = (eqFeature.geometry && eqFeature.geometry.coordinates) || [0, 0, 0];

    // Format date to UTC date string YYYY-MM-DD
    const date = new Date(time);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    if (!records[dateStr]) {
      records[dateStr] = [];
    }

    const existingIdx = records[dateStr].findIndex(eq => eq.id === id);
    if (existingIdx > -1) {
      records[dateStr][existingIdx] = {
        ...records[dateStr][existingIdx],
        report,
        ...(extraData || {})
      };
    } else {
      // Add as a new record with the report
      records[dateStr].push({
        id,
        mag,
        place,
        time,
        tsunami,
        coordinates,
        report,
        ...(extraData || {})
      });
      // Sort and keep up to 10 if there are reports, or just sort descending by magnitude
      records[dateStr].sort((a, b) => b.mag - a.mag);
    }

    this.saveRecords(records);
    return true;
  }

  /**
   * Deletes a specific earthquake from the database.
   */
  static deleteEarthquake(dateStr: string, id: string): boolean {
    const records = this.getRecords();
    if (records[dateStr]) {
      const originalLength = records[dateStr].length;
      records[dateStr] = records[dateStr].filter(eq => eq.id !== id);
      
      if (records[dateStr].length === 0) {
        delete records[dateStr];
      }
      this.saveRecords(records);
      return records[dateStr] ? records[dateStr].length < originalLength : true;
    }
    return false;
  }

  /**
   * Clears all database records.
   */
  static clearDatabase() {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch (e) {
      console.error('Failed to clear earthquake database:', e);
    }
  }
}
