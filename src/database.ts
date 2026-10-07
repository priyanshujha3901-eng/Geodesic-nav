export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: { id: string; display_name: string | null; is_anonymous: boolean; created_at: string; updated_at: string };
        Insert: { id: string; display_name?: string | null; is_anonymous?: boolean };
        Update: { display_name?: string | null };
      };
      routes: {
        Row: {
          id: string;
          created_by: string;
          origin: string;
          destination: string;
          path: string | null;
          distance_meters: number | null;
          duration_seconds: number | null;
          mode: 'car' | 'bike' | 'walk' | 'bus';
          city: string;
          created_at: string;
        };
        Insert: {
          created_by: string;
          origin: string;
          destination: string;
          path?: string | null;
          distance_meters?: number | null;
          duration_seconds?: number | null;
          mode?: 'car' | 'bike' | 'walk' | 'bus';
          city?: string;
        };
        Update: never;
      };
      groups: {
        Row: {
          id: string;
          creator_id: string;
          route_id: string | null;
          status: 'active' | 'ended';
          max_members: number;
          created_at: string;
          ended_at: string | null;
          last_activity_at: string;
        };
        Insert: never; // created via create_group() RPC
        Update: never; // mutated via RPCs only
      };
      group_members: {
        Row: {
          group_id: string;
          user_id: string;
          role: 'creator' | 'member';
          status: 'active' | 'left';
          route_id: string | null;
          joined_at: string;
          left_at: string | null;
        };
        Insert: never;
        Update: never;
      };
      group_invites: {
        Row: {
          id: string;
          group_id: string;
          invite_code: string;
          created_by: string;
          invitee_user_id: string | null;
          status: 'pending' | 'accepted' | 'declined' | 'expired';
          created_at: string;
          responded_at: string | null;
          expires_at: string;
        };
        Insert: never;
        Update: never;
      };
      user_locations: {
        Row: {
          group_id: string;
          user_id: string;
          location: string;
          latitude: number;
          longitude: number;
          speed_mps: number | null;
          heading: number | null;
          updated_at: string;
        };
        Insert: {
          group_id: string;
          user_id: string;
          location: string;
          latitude: number;
          longitude: number;
          speed_mps?: number | null;
          heading?: number | null;
          updated_at?: string;
        };
        Update: never;
      };
      group_route_mismatches: {
        Row: {
          group_id: string;
          user_a_route_id: string | null;
          user_b_route_id: string | null;
          detected_at: string;
          resolved: boolean;
        };
        Insert: never;
        Update: never;
      };
      cameras: {
        Row: {
          id: string;
          latitude: number;
          longitude: number;
          road_name: string | null;
          city: string;
          state: string;
          camera_type: 'speed' | 'red_light' | 'average_speed' | 'unknown';
          source: 'delhi_police' | 'osm' | 'ogd';
          confidence: 'high' | 'medium' | 'low';
          attribution: string | null;
          source_reference: string | null;
          last_verified_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never; // backend import only
        Update: never;
      };
    };
    Functions: {
      create_group: { Args: { p_route_id: string | null }; Returns: string };
      create_invite: { Args: { p_group_id: string }; Returns: string };
      accept_invite: { Args: { p_code: string; p_route_id: string | null }; Returns: string };
      decline_invite: { Args: { p_code: string }; Returns: void };
      leave_group: { Args: { p_group_id: string }; Returns: void };
      end_group: { Args: { p_group_id: string }; Returns: void };
      update_my_route_in_group: { Args: { p_group_id: string; p_route_id: string }; Returns: void };
    };
  };
}
