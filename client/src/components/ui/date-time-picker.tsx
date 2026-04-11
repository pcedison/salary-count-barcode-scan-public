import { useEffect, useState } from "react";
import { Calendar as CalendarIcon, Clock } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

interface DateTimePickerProps {
  mode: "date" | "time";
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function DateTimePicker({
  mode,
  value,
  onChange,
  placeholder,
  className,
}: DateTimePickerProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (mode === "date") {
    // Convert YYYY/MM/DD to Date object
    const dateValue = value ? new Date(value.replace(/\//g, "-")) : undefined;

    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "w-full justify-start text-left font-normal",
              !value && "text-muted-foreground",
              className
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {dateValue ? format(dateValue, "yyyy/MM/dd") : <span>{placeholder || "選擇日期..."}</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar
            mode="single"
            selected={dateValue}
            onSelect={(date) => {
              if (date) {
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, "0");
                const day = String(date.getDate()).padStart(2, "0");
                onChange(`${year}/${month}/${day}`);
              }
              setIsOpen(false);
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    );
  }

  // Simple Time picker with direct input
  return (
    <div className="relative flex items-center">
      <Clock className="absolute left-3 h-4 w-4 text-gray-500" />
      <Input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "pl-9 pr-4 py-2",
          !value && "text-muted-foreground",
          className
        )}
        placeholder={placeholder || "選擇時間..."}
      />
    </div>
  );
}
