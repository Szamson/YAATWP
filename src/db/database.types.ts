export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  graphql_public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
  public: {
    Tables: {
      access_logs: {
        Row: {
          accessed_at: string;
          event_id: string;
          geo_country: string | null;
          id: number;
          ip: unknown;
          pii_exposed: boolean;
          share_link_id: string;
          user_agent: string | null;
        };
        Insert: {
          accessed_at?: string;
          event_id: string;
          geo_country?: string | null;
          id?: number;
          ip?: unknown;
          pii_exposed?: boolean;
          share_link_id: string;
          user_agent?: string | null;
        };
        Update: {
          accessed_at?: string;
          event_id?: string;
          geo_country?: string | null;
          id?: number;
          ip?: unknown;
          pii_exposed?: boolean;
          share_link_id?: string;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "access_logs_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "access_logs_share_link_id_fkey";
            columns: ["share_link_id"];
            isOneToOne: false;
            referencedRelation: "share_links";
            referencedColumns: ["id"];
          },
        ];
      };
      admin_flags: {
        Row: {
          created_at: string;
          max_manual_snapshots: number;
          rate_limit_exports_daily: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          max_manual_snapshots?: number;
          rate_limit_exports_daily?: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          max_manual_snapshots?: number;
          rate_limit_exports_daily?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      analytics_events: {
        Row: {
          created_at: string;
          event_id: string | null;
          event_type: Database["public"]["Enums"]["analytics_event_type_enum"];
          id: number;
          metadata: Json | null;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          event_id?: string | null;
          event_type: Database["public"]["Enums"]["analytics_event_type_enum"];
          id?: number;
          metadata?: Json | null;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          event_id?: string | null;
          event_type?: Database["public"]["Enums"]["analytics_event_type_enum"];
          id?: number;
          metadata?: Json | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "analytics_events_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
      audit_log: {
        Row: {
          action_type: Database["public"]["Enums"]["action_type_enum"];
          created_at: string;
          details: Json | null;
          event_id: string;
          id: number;
          share_link_id: string | null;
          user_id: string | null;
        };
        Insert: {
          action_type: Database["public"]["Enums"]["action_type_enum"];
          created_at?: string;
          details?: Json | null;
          event_id: string;
          id?: number;
          share_link_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          action_type?: Database["public"]["Enums"]["action_type_enum"];
          created_at?: string;
          details?: Json | null;
          event_id?: string;
          id?: number;
          share_link_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "audit_log_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "audit_log_share_link_id_fkey";
            columns: ["share_link_id"];
            isOneToOne: false;
            referencedRelation: "share_links";
            referencedColumns: ["id"];
          },
        ];
      };
      data_requests: {
        Row: {
          event_id: string | null;
          id: string;
          processed_at: string | null;
          requested_at: string;
          result_url: string | null;
          status: Database["public"]["Enums"]["data_request_status_enum"];
          type: Database["public"]["Enums"]["data_request_type_enum"];
          user_id: string;
        };
        Insert: {
          event_id?: string | null;
          id?: string;
          processed_at?: string | null;
          requested_at?: string;
          result_url?: string | null;
          status?: Database["public"]["Enums"]["data_request_status_enum"];
          type: Database["public"]["Enums"]["data_request_type_enum"];
          user_id: string;
        };
        Update: {
          event_id?: string | null;
          id?: string;
          processed_at?: string | null;
          requested_at?: string;
          result_url?: string | null;
          status?: Database["public"]["Enums"]["data_request_status_enum"];
          type?: Database["public"]["Enums"]["data_request_type_enum"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "data_requests_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
      events: {
        Row: {
          autosave_version: number;
          created_at: string;
          deleted_at: string | null;
          event_date: string | null;
          grid_cols: number;
          grid_rows: number;
          id: string;
          lock_expires_at: string | null;
          lock_held_by: string | null;
          name: string;
          owner_id: string;
          plan_data: Json;
          updated_at: string;
        };
        Insert: {
          autosave_version?: number;
          created_at?: string;
          deleted_at?: string | null;
          event_date?: string | null;
          grid_cols: number;
          grid_rows: number;
          id?: string;
          lock_expires_at?: string | null;
          lock_held_by?: string | null;
          name: string;
          owner_id: string;
          plan_data?: Json;
          updated_at?: string;
        };
        Update: {
          autosave_version?: number;
          created_at?: string;
          deleted_at?: string | null;
          event_date?: string | null;
          grid_cols?: number;
          grid_rows?: number;
          id?: string;
          lock_expires_at?: string | null;
          lock_held_by?: string | null;
          name?: string;
          owner_id?: string;
          plan_data?: Json;
          updated_at?: string;
        };
        Relationships: [];
      };
      guest_imports: {
        Row: {
          audit_trail: Json | null;
          completed_at: string | null;
          duplicate_count: number;
          error_count: number;
          event_id: string;
          id: string;
          original_filename: string | null;
          row_count: number;
          started_at: string;
          status: Database["public"]["Enums"]["import_status_enum"];
          user_id: string;
        };
        Insert: {
          audit_trail?: Json | null;
          completed_at?: string | null;
          duplicate_count?: number;
          error_count?: number;
          event_id: string;
          id?: string;
          original_filename?: string | null;
          row_count?: number;
          started_at?: string;
          status: Database["public"]["Enums"]["import_status_enum"];
          user_id: string;
        };
        Update: {
          audit_trail?: Json | null;
          completed_at?: string | null;
          duplicate_count?: number;
          error_count?: number;
          event_id?: string;
          id?: string;
          original_filename?: string | null;
          row_count?: number;
          started_at?: string;
          status?: Database["public"]["Enums"]["import_status_enum"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "guest_imports_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
      import_consent: {
        Row: {
          consent_text: string;
          created_at: string;
          event_id: string;
          id: string;
          ip: unknown;
          user_id: string;
        };
        Insert: {
          consent_text: string;
          created_at?: string;
          event_id: string;
          id?: string;
          ip?: unknown;
          user_id: string;
        };
        Update: {
          consent_text?: string;
          created_at?: string;
          event_id?: string;
          id?: string;
          ip?: unknown;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "import_consent_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      share_links: {
        Row: {
          created_at: string;
          created_by: string;
          event_id: string;
          expires_at: string | null;
          id: string;
          include_pii: boolean;
          last_accessed_at: string | null;
          password_hash: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          token: string;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          event_id: string;
          expires_at?: string | null;
          id?: string;
          include_pii?: boolean;
          last_accessed_at?: string | null;
          password_hash?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          token: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          event_id?: string;
          expires_at?: string | null;
          id?: string;
          include_pii?: boolean;
          last_accessed_at?: string | null;
          password_hash?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          token?: string;
        };
        Relationships: [
          {
            foreignKeyName: "share_links_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
        ];
      };
      snapshots: {
        Row: {
          created_at: string;
          created_by: string;
          diff_summary: Json | null;
          event_id: string;
          id: string;
          is_manual: boolean;
          label: string | null;
          plan_data: Json;
          previous_snapshot_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by: string;
          diff_summary?: Json | null;
          event_id: string;
          id?: string;
          is_manual?: boolean;
          label?: string | null;
          plan_data: Json;
          previous_snapshot_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          diff_summary?: Json | null;
          event_id?: string;
          id?: string;
          is_manual?: boolean;
          label?: string | null;
          plan_data?: Json;
          previous_snapshot_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "snapshots_event_id_fkey";
            columns: ["event_id"];
            isOneToOne: false;
            referencedRelation: "events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "snapshots_previous_snapshot_id_fkey";
            columns: ["previous_snapshot_id"];
            isOneToOne: false;
            referencedRelation: "snapshots";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: {
      acquire_event_lock: {
        Args: { p_event_id: string; p_minutes?: number };
        Returns: boolean;
      };
      create_snapshot: {
        Args: { p_event_id: string; p_is_manual?: boolean; p_label?: string };
        Returns: string;
      };
      release_event_lock: { Args: { p_event_id: string }; Returns: boolean };
    };
    Enums: {
      action_type_enum:
        | "guest_add"
        | "guest_edit"
        | "guest_delete"
        | "table_create"
        | "table_update"
        | "seat_swap"
        | "import_started"
        | "import_completed"
        | "share_link_created"
        | "share_link_revoked"
        | "export_generated"
        | "lock_acquired"
        | "lock_released"
        | "snapshot_created"
        | "snapshot_restored"
        | "data_request_created"
        | "seat_order_changed";
      analytics_event_type_enum:
        | "event_created"
        | "import_started"
        | "import_completed"
        | "import_errors"
        | "first_save"
        | "share_link_created"
        | "share_link_clicked"
        | "export_generated"
        | "feedback_submitted";
      data_request_status_enum: "pending" | "processing" | "completed" | "rejected";
      data_request_type_enum: "export" | "deletion";
      import_status_enum: "started" | "validated" | "completed" | "failed";
      table_shape_enum: "round" | "rectangular" | "long";
    };
    CompositeTypes: Record<never, never>;
  };
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      action_type_enum: [
        "guest_add",
        "guest_edit",
        "guest_delete",
        "table_create",
        "table_update",
        "seat_swap",
        "import_started",
        "import_completed",
        "share_link_created",
        "share_link_revoked",
        "export_generated",
        "lock_acquired",
        "lock_released",
        "snapshot_created",
        "snapshot_restored",
        "data_request_created",
        "seat_order_changed",
      ],
      analytics_event_type_enum: [
        "event_created",
        "import_started",
        "import_completed",
        "import_errors",
        "first_save",
        "share_link_created",
        "share_link_clicked",
        "export_generated",
        "feedback_submitted",
      ],
      data_request_status_enum: ["pending", "processing", "completed", "rejected"],
      data_request_type_enum: ["export", "deletion"],
      import_status_enum: ["started", "validated", "completed", "failed"],
      table_shape_enum: ["round", "rectangular", "long"],
    },
  },
} as const;
